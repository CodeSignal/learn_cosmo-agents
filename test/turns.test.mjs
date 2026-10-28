import test from "node:test";
import assert from "node:assert/strict";
import { createTurnRecorder } from "../server/turns.mjs";
import { claudeTurns } from "../server/gateways/claude.mjs";
import { codexTurns } from "../server/gateways/codex.mjs";
import { opencodeTurns } from "../server/gateways/opencode.mjs";

function recorder(gateway) {
  const log = [];
  const events = { record: (type, detail) => log.push({ type, ...detail }) };
  return { log, turns: createTurnRecorder({ events, gateway, agent: "a" }) };
}

test("Claude: prompt, the engine's model and mode, the agent's tools (not the app's), the result", () => {
  const { log, turns } = recorder("claude");
  const o = claudeTurns(turns);
  o.call("session/send", { text: "fix the bug" }, { sessionId: "s1" });
  o.notify({ method: "session/message", params: { sessionId: "s1", message: { type: "system", subtype: "init", model: "claude-sonnet-5-5", permissionMode: "default" } } });
  const tool = (name, parent = null) => ({ method: "session/message", params: { sessionId: "s1", message: { type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", name }] } } } });
  for (const m of [tool("Bash"), tool("Bash"), tool("Edit"), tool("mcp__cosmo_turn__update_plan"), tool("Read", "toolu_sub")]) o.notify(m);
  o.notify({ method: "session/message", params: { sessionId: "s1", message: { type: "result", subtype: "error_during_execution" } } });
  assert.deepEqual(log[0], { type: "turn", gateway: "claude", agent: "a", sessionId: "s1", prompt: "fix the bug", promptChars: 11, model: null, mode: null });
  assert.deepEqual(log[1], { type: "turn-end", gateway: "claude", agent: "a", sessionId: "s1", outcome: "interrupted", model: "claude-sonnet-5-5", mode: "default", tools: { Bash: 2, Edit: 1 } });
  // A turn the engine starts by itself (a background task finished) is a follow-up.
  o.notify({ method: "session/message", params: { sessionId: "s1", message: { type: "result", subtype: "success" } } });
  assert.equal(log.at(-1).followUp, true);
  log.pop();
  // The next turn starts with a clean tool count and known settings; long prompts are clipped.
  o.call("session/send", { sessionId: "s1", text: "x".repeat(5000) }, { sessionId: "s1" });
  assert.equal(log[2].prompt.length, 4001);
  assert.equal(log[2].promptChars, 5000);
  assert.equal(log[2].model, "claude-sonnet-5-5");
});

test("Codex: thread model, turn/start and steer prompts, finished tool items, turn/completed", () => {
  const { log, turns } = recorder("codex");
  const o = codexTurns(turns);
  o.call("thread/start", {}, { thread: { id: "t1" }, model: "gpt-5.6-terra" });
  o.call("turn/start", { threadId: "t1", input: [{ type: "text", text: "add tests" }, { type: "mention", path: "x" }], collaborationMode: { mode: "plan" } }, { turn: { id: "u1" } });
  o.call("turn/steer", { threadId: "t1", input: [{ type: "text", text: "also docs" }] }, {});
  for (const item of [{ type: "commandExecution" }, { type: "agentMessage" }, { type: "fileChange" }, { type: "mcpToolCall", server: "docs", tool: "search" }]) {
    o.notify({ method: "item/completed", params: { threadId: "t1", item } });
  }
  o.notify({ method: "turn/completed", params: { threadId: "t1", turn: { status: "completed" } } });
  assert.equal(log[0].prompt, "add tests");
  assert.equal(log[0].model, "gpt-5.6-terra");
  assert.equal(log[0].mode, "plan");
  assert.equal(log[1].steer, true);
  assert.deepEqual(log[2], { type: "turn-end", gateway: "codex", agent: "a", sessionId: "t1", outcome: "completed", model: "gpt-5.6-terra", mode: "plan", tools: { commandExecution: 1, fileChange: 1, "mcp:docs/search": 1 } });
});

test("OpenCode: the user message's text once, tool parts once each, idle and errors end the turn", () => {
  const { log, turns } = recorder("opencode");
  const on = opencodeTurns(turns);
  on({ type: "message.updated", properties: { info: { id: "m1", role: "user", sessionID: "s", agent: "build", model: { modelID: "claude-sonnet-5-5" } } } });
  const text = { type: "message.part.updated", properties: { part: { type: "text", messageID: "m1", sessionID: "s", text: "hello" } } };
  on(text);
  on(text); // text parts update as they stream; the prompt counts once
  const toolPart = (status) => ({ type: "message.part.updated", properties: { part: { type: "tool", callID: "c1", sessionID: "s", tool: "bash", state: { status } } } });
  on(toolPart("running"));
  on(toolPart("completed"));
  on(toolPart("completed"));
  on({ type: "session.idle", properties: { sessionID: "s" } });
  on({ type: "session.idle", properties: { sessionID: "s" } }); // idle without a turn: nothing
  assert.equal(log.filter((e) => e.type === "turn").length, 1);
  assert.deepEqual(log[0], { type: "turn", gateway: "opencode", agent: "a", sessionId: "s", prompt: "hello", promptChars: 5, model: "claude-sonnet-5-5", mode: "build" });
  assert.deepEqual(log[1].tools, { bash: 1 });
  assert.equal(log.length, 2);
  // A failed turn reports the error, then goes idle: it ends once.
  on({ type: "message.updated", properties: { info: { id: "m2", role: "user", sessionID: "s", agent: "build" } } });
  on({ type: "message.part.updated", properties: { part: { type: "text", messageID: "m2", sessionID: "s", text: "stop" } } });
  on({ type: "session.error", properties: { sessionID: "s", error: { name: "MessageAbortedError" } } });
  on({ type: "session.idle", properties: { sessionID: "s" } });
  assert.deepEqual(log.slice(2).map((e) => e.outcome ?? e.type), ["turn", "interrupted"]);
});
