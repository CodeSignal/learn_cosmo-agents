import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTranscript, commandCategory } from "../server/transcript.mjs";
import { claudeTranscript } from "../server/gateways/claude.mjs";
import { codexTranscript } from "../server/gateways/codex.mjs";
import { opencodeTranscript } from "../server/gateways/opencode.mjs";

let clock = Date.parse("2026-11-02T10:00:00Z");
const now = () => new Date((clock += 1000));
const transcript = (extra = {}) => createTranscript({ agent: "a", project: "/usercode/FILESYSTEM", now, ...extra });
const lines = (t) => t.render().summary;

test("Claude: prompts, replies, tools, errors, commands, files, tokens and modes, as the provisioner writes them", () => {
  const t = transcript();
  const o = claudeTranscript(t);
  const msg = (message) => o.notify({ method: "session/message", params: { sessionId: "s1", message } });
  o.call("session/send", { text: "add a test", permissionMode: "default" }, { sessionId: "s1" });
  msg({ type: "system", subtype: "init", model: "claude-sonnet-5-5", permissionMode: "default" });
  msg({ type: "assistant", message: { content: [{ type: "text", text: "On it." }, { type: "tool_use", id: "u1", name: "Write", input: { file_path: "test.js" } }, { type: "tool_use", id: "u2", name: "Bash", input: { command: "npm test" } }, { type: "tool_use", id: "u3", name: "mcp__cosmo_turn__update_plan", input: {} }] } });
  msg({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }, { type: "tool_result", tool_use_id: "u2", is_error: true, content: [{ type: "text", text: "1 failing" }] }] } });
  msg({ type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "a subagent's own words" }] } });
  msg({ type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 20 } });
  o.call("session/configure", { sessionId: "s1", permissionMode: "auto" }, {});
  const [session, interaction] = lines(t);
  assert.equal(session.kind, "session");
  assert.equal(session.model, "claude-sonnet-5-5");
  assert.equal(session.num_user_messages, 1);
  assert.equal(session.num_tool_calls, 2); // the app's own tools aren't the agent's
  assert.equal(session.num_tool_errors, 1);
  assert.deepEqual(session.tool_errors_by_tool, { Bash: 1 });
  assert.deepEqual(session.permission_modes_used, ["auto", "default"]);
  assert.deepEqual(session.bash_categories, { test: 1 });
  assert.equal(session.num_files_edited_by_ai, 1);
  assert.deepEqual(session.tokens, { input_tokens: 100, output_tokens: 20 });
  assert.equal(interaction.input_text, "add a test");
  assert.equal(interaction.input_source, "typed");
  assert.equal(interaction.assistant_response_text, "On it.");
  assert.deepEqual(interaction.files_touched, [{ path: "test.js", action: "ai_write" }]);
  assert.deepEqual(interaction.bash_commands, [{ command: "npm test", category: "test" }]);
  assert.deepEqual(interaction.tool_results[1], { tool_use_id: "u2", tool_name: "Bash", is_error: true, error_text: "1 failing" });
  const { timeline } = t.render();
  assert.match(timeline, /MODE → default[\s\S]*USER:\n  add a test[\s\S]*TOOL ERROR \(Bash\):\n  1 failing[\s\S]*MODE → auto/);
  assert.doesNotMatch(timeline, /subagent's own/);
});

test("Codex: approval policies as modes, commands with output, file changes, token usage", () => {
  const t = transcript({ modeKey: "approval" }); // as the Codex gateway creates it
  const o = codexTranscript(t);
  o.call("thread/start", {}, { thread: { id: "t1" }, model: "gpt-5.6-terra", approvalPolicy: "untrusted" });
  o.call("turn/start", { threadId: "t1", input: [{ type: "text", text: "fix it" }], approvalPolicy: "on-request" }, {});
  o.notify({ method: "item/completed", params: { threadId: "t1", item: { type: "commandExecution", id: "c1", command: "pytest -q", aggregatedOutput: "1 passed", exitCode: 0, status: "completed" } } });
  o.notify({ method: "item/completed", params: { threadId: "t1", item: { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "a.py", kind: { type: "update" } }, { path: "b.py", kind: { type: "add" } }] } } });
  o.notify({ method: "item/completed", params: { threadId: "t1", item: { type: "agentMessage", id: "m1", text: "Fixed." } } });
  o.notify({ method: "thread/tokenUsage/updated", params: { threadId: "t1", tokenUsage: { last: { inputTokens: 50, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 1, totalTokens: 55 } } } });
  o.notify({ method: "turn/completed", params: { threadId: "t1", turn: { status: "completed" } } });
  const [session, interaction] = lines(t);
  assert.deepEqual(session.approval_modes_used, ["on-request", "untrusted"]);
  assert.equal(session.permission_modes_used, undefined);
  assert.equal(interaction.assistant_response_text, "Fixed.");
  assert.deepEqual(interaction.bash_commands, [{ command: "pytest -q", category: "test", exit_code: 0 }]);
  assert.deepEqual(interaction.files_touched, [{ path: "a.py", action: "ai_edit" }, { path: "b.py", action: "ai_write" }]);
  assert.equal(interaction.tokens.total_tokens, 55);
  assert.match(t.render().timeline, /\$ pytest -q\n  1 passed/);
});

test("OpenCode: the prompt once, the reply when it completes, tools with their output", () => {
  const t = transcript();
  const on = opencodeTranscript(t);
  on({ type: "message.updated", properties: { info: { id: "m1", role: "user", sessionID: "s", agent: "build", model: { modelID: "claude-sonnet-5-5" } } } });
  const prompt = { type: "message.part.updated", properties: { part: { id: "p1", type: "text", messageID: "m1", sessionID: "s", text: "hello" } } };
  on(prompt);
  on(prompt);
  on({ type: "message.part.updated", properties: { part: { id: "p2", type: "text", messageID: "a1", sessionID: "s", text: "Hel" } } });
  on({ type: "message.part.updated", properties: { part: { id: "p2", type: "text", messageID: "a1", sessionID: "s", text: "Hello there" } } });
  on({ type: "message.part.updated", properties: { part: { type: "tool", callID: "c1", sessionID: "s", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a.txt" } } } });
  on({ type: "message.part.updated", properties: { part: { type: "tool", callID: "c2", sessionID: "s", tool: "edit", state: { status: "error", input: { filePath: "a.txt" }, error: "denied" } } } });
  on({ type: "message.updated", properties: { info: { id: "a1", role: "assistant", sessionID: "s", modelID: "claude-sonnet-5-5", time: { completed: 1 }, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0 } } } } });
  const [session, interaction] = lines(t);
  assert.equal(session.num_user_messages, 1);
  assert.deepEqual(session.permission_modes_used, ["build"]);
  assert.equal(interaction.assistant_response_text, "Hello there");
  assert.deepEqual(interaction.tools_used, ["bash", "edit"]);
  assert.deepEqual(interaction.tool_results.map((r) => r.is_error), [false, true]);
  assert.deepEqual(interaction.bash_commands, [{ command: "ls", category: "inspect" }]);
  assert.deepEqual(session.tokens, { input_tokens: 10, output_tokens: 2, reasoning_output_tokens: 0, cached_input_tokens: 0 });
});

test("files: the next free index, a summary and timeline parts, rewritten as the record grows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-"));
  fs.writeFileSync(path.join(dir, "interactions_summary.2.jsonl"), "");
  const t = transcript({ dir, delay: 5 });
  t.prompt("s", "one");
  t.text("s", "x".repeat(80_000));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(fs.existsSync(path.join(dir, "interactions_summary.3.jsonl")));
  const parts = fs.readdirSync(dir).filter((f) => f.startsWith("timeline.3.part")).sort();
  assert.deepEqual(parts, ["timeline.3.part1.txt", "timeline.3.part2.txt"]);
  assert.ok(fs.statSync(path.join(dir, parts[0])).size <= 70_000);
  t.prompt("s", "two");
  await new Promise((r) => setTimeout(r, 30));
  const summary = fs.readFileSync(path.join(dir, "interactions_summary.3.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(summary.filter((r) => r.kind === "interaction").map((r) => r.input_text), ["one", "two"]);
});

test("command categories", () => {
  assert.equal(commandCategory("npm test"), "test");
  assert.equal(commandCategory("pip install requests"), "install");
  assert.equal(commandCategory("git status"), "git");
  assert.equal(commandCategory("cat a.txt"), "inspect");
  assert.equal(commandCategory("echo hi"), "other");
});
