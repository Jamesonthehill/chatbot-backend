import test from "node:test";
import assert from "node:assert/strict";
import { guidedTurn as runGuidedTurn } from "./guided-demo.mjs";
import { signDocument } from "./guided-documents.mjs";
import { readFileSync } from "node:fs";
process.env.OPENAI_API_KEY ||= "test-only-document-signing-key";
const fixture = JSON.parse(readFileSync(new URL("./tests/fixtures/learning-material.json", import.meta.url)));
const documentToken = signDocument({...fixture,title:"Uploaded test document"});
const guidedTurn = (client, body={}) => runGuidedTurn(client, {document_token:documentToken,...body});

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

test("Jarvis and Socrates share questions and progression while only tone differs", async () => {
  for (const mode of ["jarvis", "socrates"]) {
    const client = mockClient();
    const initial = await guidedTurn(client, { action: "start", ...(mode === "socrates" ? {tutor_mode:mode} : {}) });
    assert.equal(initial.tutor_mode, mode);
    assert.ok(initial.messages[0].next_thinking_step.endsWith("?"));
    const original = initial.socratic.next_thinking_step;
    client.outputs.push({ subtopic_request: true, retrieval_query: "What is code review?" },
      { lead_in: "A teammate checks your change before it is merged.", next_question: "Does that help?", lead_emphasis: "checks your change", question_emphasis: "Does that help?", ready: true });
    const reply = await guidedTurn(client, { message: "What is code review?", history: initial.messages, engine_state: initial.socratic });
    assert.equal(reply.messages.at(-1).next_thinking_step, "**Does that help?**");
    assert.equal(reply.socratic.learning_detour.question, original);
    assert.equal(reply.socratic.step_readiness.ready, false);
    assert.match(client.requests.at(-1).messages[0].content, mode === "jarvis" ? /helpful friend/ : /formal, supportive/);
    assert.match(client.requests.at(-1).messages[0].content, /same Socratic learning process/);
    const switched = await guidedTurn({}, { action: "set_mode", tutor_mode: mode === "jarvis" ? "socrates" : "jarvis", history: reply.messages, engine_state: reply.socratic });
    assert.deepEqual(switched.messages, reply.messages);
    assert.equal(switched.socratic.learning_detour.question, original);
    const resumed = await guidedTurn({}, { action: "resume", history: switched.messages, engine_state: switched.socratic });
    assert.equal(resumed.socratic.next_thinking_step, original);
    const next = await guidedTurn({}, { action: "continue", history: resumed.messages, engine_state: {...resumed.socratic,step_readiness:{ready:true}} });
    assert.equal(next.socratic.learning_step_index, 1);
    assert.equal(next.tutor_mode, switched.tutor_mode);
  }
  await assert.rejects(guidedTurn({}, { action: "start", tutor_mode: "invalid" }), /Choose Jarvis/);
});

test("older Javis sessions are accepted under the corrected Jarvis name", async () => {
  const old = await guidedTurn({}, { action: "start", tutor_mode: "javis" });
  assert.equal(old.tutor_mode, "jarvis");
  const reply = await guidedTurn({}, { action:"set_mode", tutor_mode:"jarvis", history:old.messages.map(message=>({...message,tutor_mode:"javis"})), engine_state:{...old.socratic,tutor_mode:"javis"} });
  assert.equal(reply.messages[0].tutor_mode,"jarvis");
  assert.equal(reply.messages[0].content,old.messages[0].content);
  assert.equal(reply.socratic.next_thinking_step,old.socratic.next_thinking_step);
});

test("chat actions require an uploaded document and never fall back to sample content", async () => {
  for (const action of ["start", "message", "set_mode", "continue", "resume", "finish"]) {
    await assert.rejects(runGuidedTurn({}, {action,message:"Explain this"}), error=>error.status===422 && /Upload a document/.test(error.message));
  }
});
