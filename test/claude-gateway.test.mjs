import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { METHODS, checkParams, checkAnswer } from "../server/gateways/claude.mjs";
import { claudeCeilings } from "../policy/render.mjs";
import { validateTaskConfig } from "../policy/schema.mjs";

const ctx = { models: ["claude-sonnet-5-5", "default", "sonnet"], modes: ["default", "acceptEdits", "plan"] };
const reason = (method, params) => checkParams(method, params, ctx).reason;
const SID = "6a65de5f-2584-4484-a240-6ac4b43731f0";
const host = fs.readFileSync(new URL("../engines/claude-host/host.mjs", import.meta.url), "utf8");

test("every engine host method is classified, and every allowed method exists in the host", () => {
  const handlers = [...host.matchAll(/^\s+async (?:"([^"]+)"|(\w+))\(/gm)].map((m) => m[1] ?? m[2]);
  assert.ok(handlers.includes("session/send"));
  for (const method of handlers) assert.ok(Object.hasOwn(METHODS, method), `${method} is not classified`);
  for (const [method, decision] of Object.entries(METHODS)) if (decision === "allow") assert.ok(handlers.includes(method), `${method} is allowed but the host has no handler`);
  assert.notEqual(METHODS["session/delete"], "allow");
});

test("the Agent SDK pin matches the engine pin (0.3.n drives 2.1.n)", () => {
  const pins = JSON.parse(fs.readFileSync(new URL("../policy/pins.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(new URL("../engines/claude-host/package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(fs.readFileSync(new URL("../engines/claude-host/package-lock.json", import.meta.url), "utf8"));
  const patch = pins.engines.claude.version.split(".")[2];
  assert.equal(pkg.dependencies["@anthropic-ai/claude-agent-sdk"], `0.3.${patch}`);
  assert.equal(lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"].version, `0.3.${patch}`);
});

test("settings: models from the task (or the engine's aliases), modes without bypass", () => {
  assert.equal(reason("session/send", { text: "hi", model: "claude-sonnet-5-5", permissionMode: "plan", effort: "high" }), undefined);
  assert.match(reason("session/send", { text: "hi", model: "claude-opus-5-5" }), /model/);
  for (const mode of ["bypassPermissions", "dontAsk", "auto"]) assert.match(reason("session/configure", { sessionId: SID, permissionMode: mode }), /permission mode/);
  assert.match(reason("session/configure", { sessionId: SID, effort: "ultra" }), /effort/);
  const { config: c } = validateTaskConfig({ agents: ["cosmo-code"] });
  assert.deepEqual(claudeCeilings(c).modes, ["default", "acceptEdits", "plan"]);
  assert.equal(claudeCeilings(c).defaultMode, "default");
});

test("only the parameters a method declares pass; sessions and messages are ids", () => {
  assert.match(reason("session/send", { text: "hi", cwd: "/" }), /"cwd" option/);
  assert.match(reason("session/send", { text: "hi", settingSources: ["user"] }), /option/);
  assert.match(reason("session/send", { text: "hi", pathToClaudeCodeExecutable: "/tmp/x" }), /option/);
  assert.match(reason("session/read", { sessionId: "../../etc/passwd" }), /session/);
  assert.match(reason("session/read", {}), /session/);
  assert.match(reason("session/rewindFiles", { sessionId: SID }), /message/);
  assert.equal(reason("session/fork", { sessionId: SID, upToMessageId: SID, title: "copy" }), undefined);
  assert.match(reason("session/send", { text: "   " }), /message/);
  assert.match(reason("session/archive", { sessionId: SID, archived: "yes" }), /archived/);
  assert.equal(reason("files/search", { query: "gre", limit: 20 }), undefined);
  assert.match(reason("files/search", { query: "x".repeat(300) }), /search/);
  assert.match(reason("files/search", { query: "a", root: "/" }), /option/);
});

test("rewind, files and the terminal: ids, relative paths and sizes only", () => {
  assert.equal(reason("session/rewind", { sessionId: SID, userMessageId: SID }), undefined);
  assert.match(reason("session/rewind", { sessionId: SID }), /message/);
  assert.equal(reason("files/read", { path: "src/greet.js" }), undefined);
  for (const path of ["/etc/passwd", "../x", "a/../../b", ""]) assert.match(reason("files/read", { path }), /outside/);
  assert.equal(reason("terminal/open", { cols: 120, rows: 30 }), undefined);
  assert.match(reason("terminal/open", { cols: 1e6, rows: 30 }), /size/);
  assert.match(reason("terminal/open", { cmd: "sh" }), /option/);
  assert.match(reason("terminal/write", { id: "x", data: "aGk=" }), /terminal/);
  assert.match(reason("terminal/write", { id: SID, data: "not base64!" }), /input/);
  assert.equal(METHODS["terminal/open"], "terminal");
});

test("answers: allow or deny; always-allow only the rule the engine suggested; edited input only for questions", () => {
  const bash = {
    method: "session/permission",
    params: { toolName: "Bash", input: { command: "npm test" }, suggestions: [{ type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }] }] },
  };
  assert.deepEqual(checkAnswer(bash, { behavior: "allow" }), { result: { behavior: "allow" }, reply: "once" });
  assert.deepEqual(checkAnswer(bash, { behavior: "allow", alwaysAllow: true, ruleContent: "npm test:*" }).result, { behavior: "allow", alwaysAllow: true, ruleContent: "npm test:*" });
  assert.match(checkAnswer(bash, { behavior: "allow", alwaysAllow: true, ruleContent: "*" }).reason, /rule/);
  assert.match(checkAnswer(bash, { behavior: "allow", answers: { q: "a" } }).reason, /input/);
  assert.match(checkAnswer(bash, { behavior: "maybe" }).reason, /answer/);
  assert.deepEqual(checkAnswer(bash, { behavior: "deny", message: "not now", updatedInput: { command: "rm -rf /" } }), { result: { behavior: "deny", message: "not now", interrupt: false }, reply: "deny" });
  const network = { method: "session/permission", params: { toolName: "SandboxNetworkAccess", input: { host: "example.com" } } };
  assert.match(checkAnswer(network, { behavior: "allow" }, { webTools: false }).reason, /network/);
  assert.equal(checkAnswer(network, { behavior: "deny" }, { webTools: false }).result.behavior, "deny");
  assert.equal(checkAnswer(network, { behavior: "allow" }, { webTools: true }).result.behavior, "allow");
  const question = { method: "session/permission", params: { toolName: "AskUserQuestion", input: { questions: [] } } };
  assert.deepEqual(checkAnswer(question, { behavior: "allow", answers: { "Which fix?": "The operator" } }).result, { behavior: "allow", answers: { "Which fix?": "The operator" } });
  assert.match(checkAnswer(question, { behavior: "allow", answers: { q: 1 } }).reason, /answers/);
});
