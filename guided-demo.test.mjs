import test from "node:test";
import assert from "node:assert/strict";
import { guidedTurn } from "./guided-demo.mjs";

function mockClient() {
  const outputs = [];
  return {
    outputs,
    chat: { completions: { create: async request => {
      assert.equal(request.model, process.env.PORTFOLIO_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini");
      return { choices: [{ message: { content: JSON.stringify(outputs.shift()) } }] };
    } } },
    embeddings: { create: async ({ input }) => ({
      data: (Array.isArray(input) ? input : [input]).map(() => ({ embedding: [1, 0] })),
    }) },
  };
}

test("guided activity starts with material and three steps", async () => {
  const result = await guidedTurn({}, { action: "start" });
  assert.equal(result.steps.length, 3);
  assert.match(result.messages[0].content, /empty-list/);
  assert.match(result.material, /Code review practice guide/);
});

test("a subtopic preserves the exact paused question and scenario", async () => {
  const client = mockClient();
  const initial = await guidedTurn(client, { action: "start" });
  const original = initial.socratic.next_thinking_step;
  client.outputs.push({ subtopic_request: true, retrieval_query: "What is an edge case?" },
    { lead_in: "An edge case is an unusual input.", next_question: "What happens when the list is empty?",
      lead_emphasis: "unusual input", question_emphasis: "What happens when the list is empty?", ready: true });
  const detour = await guidedTurn(client, { message: "What is an edge case?", history: initial.messages, engine_state: initial.socratic });
  assert.equal(detour.socratic.learning_detour.question, original);
  assert.equal(detour.socratic.step_readiness.ready, false);
  const resumed = await guidedTurn(client, { action: "resume", history: detour.messages, engine_state: detour.socratic });
  assert.equal(resumed.socratic.next_thinking_step, original);
  assert.match(resumed.messages.at(-1).content, /teammate reports/);
});

test("advance requires readiness and clears prior step state", async () => {
  const initial = await guidedTurn({}, { action: "start" });
  await assert.rejects(guidedTurn({}, { action: "continue", history: initial.messages, engine_state: initial.socratic }), /Complete/);
  const next = await guidedTurn({}, { action: "continue", history: initial.messages,
    engine_state: { ...initial.socratic, step_readiness: { ready: true } } });
  assert.equal(next.socratic.learning_step_index, 1);
  assert.equal(next.socratic.step_readiness, undefined);
});

test("summary completes only at the last ready step", async () => {
  const client = mockClient();
  const initial = await guidedTurn({}, { action: "start" });
  await assert.rejects(guidedTurn(client, { action: "finish", message: "My summary", history: initial.messages }), /Complete/);
  client.outputs.push({ subtopic_request: false, retrieval_query: "Review testing" },
    { lead_in: "You explained why edge-case tests matter.", next_question: "", lead_emphasis: "edge-case tests matter", question_emphasis: "", ready: true });
  const done = await guidedTurn(client, { action: "finish", message: "Test edge cases before merging.",
    history: initial.messages, engine_state: { learning_step_index: 2, step_readiness: { ready: true } } });
  assert.equal(done.socratic.phase, "completed");
});
