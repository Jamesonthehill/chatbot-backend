import test from "node:test";
import assert from "node:assert/strict";
import { guidedTurn } from "./guided-demo.mjs";

function mockClient() {
  const outputs = [];
  const requests = [];
  return {
    outputs, requests,
    chat: { completions: { create: async request => {
      requests.push(request);
      assert.equal(request.model, process.env.PORTFOLIO_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini");
      return { choices: [{ message: { content: JSON.stringify(outputs.shift()) } }] };
    } } },
    embeddings: { create: async ({ input }) => ({
      data: (Array.isArray(input) ? input : [input]).map(() => ({ embedding: [1, 0] })),
    }) },
  };
}

test("guided activity starts with material and three steps", async () => {
  const result = await guidedTurn({}, { action: "start", tutor_mode: "socrates" });
  assert.equal(result.steps.length, 3);
  assert.match(result.messages[0].content, /empty-list/);
  assert.match(result.material, /Code review practice guide/);
  assert.match(result.messages[0].lead_in, /teammate reports/);
  assert.equal(result.messages[0].next_thinking_step, result.socratic.next_thinking_step);
});

test("a subtopic preserves the exact paused question and scenario", async () => {
  const client = mockClient();
  const initial = await guidedTurn(client, { action: "start", tutor_mode: "socrates" });
  const original = initial.socratic.next_thinking_step;
  client.outputs.push({ subtopic_request: true, retrieval_query: "What is an edge case?" },
    { lead_in: "An edge case is an unusual input.", next_question: "What happens when the list is empty?",
      lead_emphasis: "unusual input", question_emphasis: "What happens when the list is empty?", ready: true });
  const detour = await guidedTurn(client, { message: "What is an edge case?", history: initial.messages, engine_state: initial.socratic });
  assert.equal(detour.socratic.learning_detour.question, original);
  assert.ok(detour.messages.at(-1).sources[0].length > 0);
  assert.equal(detour.socratic.step_readiness.ready, false);
  const resumed = await guidedTurn(client, { action: "resume", history: detour.messages, engine_state: detour.socratic });
  assert.equal(resumed.socratic.next_thinking_step, original);
  assert.match(resumed.messages.at(-1).content, /teammate reports/);
});

test("advance requires readiness and clears prior step state", async () => {
  const initial = await guidedTurn({}, { action: "start", tutor_mode: "socrates" });
  await assert.rejects(guidedTurn({}, { action: "continue", history: initial.messages, engine_state: initial.socratic }), /Complete/);
  const next = await guidedTurn({}, { action: "continue", history: initial.messages,
    engine_state: { ...initial.socratic, step_readiness: { ready: true } } });
  assert.equal(next.socratic.learning_step_index, 1);
  assert.equal(next.socratic.step_readiness, undefined);
});

test("summary completes only at the last ready step", async () => {
  const client = mockClient();
  const initial = await guidedTurn({}, { action: "start", tutor_mode: "socrates" });
  await assert.rejects(guidedTurn(client, { action: "finish", tutor_mode: "socrates", message: "My summary", history: initial.messages }), /Complete/);
  client.outputs.push({ subtopic_request: false, retrieval_query: "Review testing" },
    { lead_in: "You explained why edge-case tests matter.", next_question: "", lead_emphasis: "edge-case tests matter", question_emphasis: "", ready: true });
  const done = await guidedTurn(client, { action: "finish", message: "Test edge cases before merging.",
    history: initial.messages, engine_state: { tutor_mode: "socrates", learning_step_index: 2, step_readiness: { ready: true } } });
  assert.equal(done.socratic.phase, "completed");
});

test("Javis is the default, answers directly, and preserves the question when switching", async () => {
  const client = mockClient();
  const initial = await guidedTurn(client, { action: "start" });
  assert.equal(initial.tutor_mode, "javis");
  assert.match(initial.messages[0].lead_in, /Javis/);
  assert.equal(initial.messages[0].next_thinking_step, "");
  const original = initial.socratic.next_thinking_step;
  client.outputs.push({ subtopic_request: true, retrieval_query: "What is code review?" },
    { lead_in: "Code review is a teammate checking your change before it is merged.", next_question: "Unexpected quiz?", lead_emphasis: "checking your change", question_emphasis: "", ready: true });
  const reply = await guidedTurn(client, { message: "What is code review?", history: initial.messages, engine_state: initial.socratic });
  assert.equal(reply.messages.at(-1).next_thinking_step, "");
  assert.equal(reply.socratic.learning_detour, undefined);
  assert.equal(reply.socratic.next_thinking_step, original);
  assert.match(client.requests.at(-1).messages[0].content, /Answer the student's latest question directly/);
  const switched = await guidedTurn({}, { action: "set_mode", tutor_mode: "socrates", history: reply.messages, engine_state: reply.socratic });
  assert.equal(switched.messages.length, reply.messages.length + 1);
  assert.equal(switched.messages.at(-1).next_thinking_step, original);
  assert.equal(switched.tutor_mode, "socrates");
  assert.equal(switched.messages[1].content, reply.messages[1].content);
  const back = await guidedTurn({}, { action: "set_mode", tutor_mode: "javis", history: switched.messages, engine_state: switched.socratic });
  assert.equal(back.socratic.next_thinking_step, original);
  assert.equal(back.socratic.learning_step_index, 0);
  await assert.rejects(guidedTurn({}, { action: "start", tutor_mode: "invalid" }), /Choose Javis/);
});
