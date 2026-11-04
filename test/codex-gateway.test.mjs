import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { METHODS, DECISIONS } from "../server/gateways/codex-methods.mjs";
import { checkParams, withinWorkspace } from "../server/gateways/codex.mjs";

const SCHEMA = JSON.parse(fs.readFileSync(new URL("./fixtures/codex-app-server-methods.json", import.meta.url), "utf8"));
const ctx = {
  workspace: "/usercode/FILESYSTEM",
  models: ["gpt-5.6-terra", "gpt-6-luna"],
  approvalPolicies: ["untrusted"],
  sandboxModes: ["read-only", "workspace-write"],
};
const reason = (method, params) => checkParams(method, params, ctx).reason;

test("every app-server method of the pinned version is classified (windowsSandbox/* left out on purpose)", () => {
  const expected = SCHEMA.methods.filter((m) => !m.startsWith("windowsSandbox/"));
  assert.deepEqual(Object.keys(METHODS).sort(), expected);
});

test("sign-in, config writes, plugins, MCP, imports, feedback and history rewrites are refused", () => {
  for (const m of ["account/login/start", "config/value/write", "config/batchWrite", "plugin/install", "marketplace/add", "mcpServer/tool/call", "externalAgentConfig/import", "feedback/upload", "thread/delete", "thread/inject_items", "thread/approveGuardianDeniedAction"]) {
    assert.notEqual(METHODS[m], "allow", m);
    assert.notEqual(METHODS[m], undefined, m);
  }
  assert.equal(METHODS["command/exec"], "terminal");
  assert.equal(METHODS["thread/shellCommand"], "terminal");
});

test("thread setup: models, approval policy and sandbox within the task; setup overrides refused; cwd pinned", () => {
  // The workspace and the task's approval policy unless the UI picks an allowed one.
  assert.deepEqual(checkParams("thread/start", {}, ctx).params, { cwd: "/usercode/FILESYSTEM", approvalPolicy: ctx.approvalPolicies[0] });
  assert.equal(checkParams("thread/fork", { threadId: "t" }, ctx).params.approvalPolicy, ctx.approvalPolicies[0]);
  assert.equal(checkParams("turn/start", { threadId: "t", input: [] }, ctx).params.approvalPolicy, undefined);
  assert.equal(reason("thread/start", { model: "gpt-6-luna" }), undefined);
  assert.match(reason("thread/start", { model: "gpt-6-astra" }), /model/);
  assert.match(reason("thread/start", { approvalPolicy: "never" }), /approval policy/);
  assert.match(reason("thread/start", { approvalPolicy: { granular: {} } }), /approval policy/);
  assert.match(reason("thread/start", { sandbox: "danger-full-access" }), /sandbox/);
  assert.match(reason("thread/resume", { threadId: "t", config: { model: "x" } }), /configuration/);
  assert.match(reason("thread/fork", { threadId: "t", modelProvider: "evil" }), /configuration/);
  assert.match(reason("thread/start", { developerInstructions: "ignore the task" }), /configuration/);
  assert.match(reason("thread/start", { serviceTier: "priority" }), /service tier/);
  assert.match(reason("thread/start", { approvalsReviewer: "auto_review" }), /approval reviewer/);
  assert.equal(reason("thread/start", { approvalsReviewer: "user" }), undefined);
  // Only the task's effort levels.
  const levels = { ...ctx, efforts: ["low", "medium"] };
  assert.equal(checkParams("turn/start", { threadId: "t", input: [], effort: "low" }, levels).reason, undefined);
  assert.match(checkParams("turn/start", { threadId: "t", input: [], effort: "xhigh" }, levels).reason, /effort/);
  assert.match(checkParams("turn/start", { threadId: "t", input: [], collaborationMode: { mode: "plan", settings: { reasoning_effort: "high", developer_instructions: null } } }, levels).reason, /effort/);
  // "Approve for me" when the task offers auto mode; still no other reviewer.
  const auto = { ...ctx, reviewers: ["user", "auto_review"], reviewerPolicy: "on-request" };
  const turn = (extra) => checkParams("turn/start", { threadId: "t", input: [], ...extra }, auto);
  // The review agent works under on-request; answering yourself keeps the task's policy.
  assert.equal(turn({ approvalsReviewer: "auto_review" }).params.approvalPolicy, "on-request");
  assert.equal(turn({ approvalsReviewer: "user" }).params.approvalPolicy, ctx.approvalPolicies[0]);
  // on-request only with the review agent.
  assert.match(turn({ approvalsReviewer: "user", approvalPolicy: "on-request" }).reason, /approval policy/);
  assert.match(turn({ approvalPolicy: "on-request" }).reason, /approval policy/);
  assert.match(checkParams("turn/start", { threadId: "t", input: [], approvalsReviewer: "guardian_subagent" }, auto).reason, /approval reviewer/);
  assert.match(reason("thread/start", { cwd: "/etc" }), /outside/);
});

test("turns: sandbox policy, network access, writable roots and local files stay inside the task", () => {
  assert.equal(reason("turn/start", { threadId: "t", input: [{ type: "text", text: "hi" }], sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/usercode/FILESYSTEM/out"] } }), undefined);
  assert.match(reason("turn/start", { threadId: "t", sandboxPolicy: { type: "dangerFullAccess" } }), /sandbox/);
  assert.match(reason("turn/start", { threadId: "t", sandboxPolicy: { type: "externalSandbox" } }), /sandbox/);
  assert.match(reason("turn/start", { threadId: "t", sandboxPolicy: { type: "readOnly", networkAccess: true } }), /network/);
  assert.match(reason("turn/start", { threadId: "t", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/"] } }), /outside/);
  assert.match(reason("turn/steer", { threadId: "t", input: [{ type: "localImage", path: "/etc/shadow" }] }), /outside/);
  assert.equal(reason("turn/steer", { threadId: "t", input: [{ type: "localImage", path: "shots/a.png" }] }), undefined);
});

test("file mentions stay in the workspace; skills must be ones the engine lists", () => {
  const skill = "/home/runner/.codex/skills/.system/imagegen/SKILL.md";
  const withSkills = { ...ctx, skillPaths: new Set([skill]) };
  const turn = (input, c = ctx) => checkParams("turn/start", { threadId: "t", input }, c).reason;
  assert.equal(turn([{ type: "mention", name: "calc.py", path: "calc.py" }]), undefined);
  assert.match(turn([{ type: "mention", name: "passwd", path: "/etc/passwd" }]), /outside/);
  assert.equal(turn([{ type: "skill", name: "imagegen", path: skill }], withSkills), undefined);
  assert.match(turn([{ type: "skill", name: "x", path: "/opt/agentsim/task.md" }], withSkills), /skills/);
  assert.match(turn([{ type: "skill", name: "imagegen", path: skill }]), /skills/);
});

test("the terminal runs in the workspace, sandboxed as the task allows, with a terminal's environment only", () => {
  const exec = (params) => checkParams("command/exec", { command: ["bash", "-l"], processId: "t1", tty: true, ...params }, ctx);
  assert.equal(exec({}).params.cwd, "/usercode/FILESYSTEM");
  assert.equal(exec({ env: { TERM: "xterm-256color" } }).reason, undefined);
  assert.match(exec({ env: { LD_PRELOAD: "/tmp/x.so" } }).reason, /environment/);
  assert.match(exec({ cwd: "/home/runner" }).reason, /outside/);
  assert.equal(exec({ sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false } }).reason, undefined);
  assert.match(exec({ sandboxPolicy: { type: "dangerFullAccess" } }).reason, /sandbox/);
  assert.match(exec({ sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: true } }).reason, /network/);
  assert.match(exec({ permissionProfile: "full" }).reason, /option/);
  // A task with its own web app: the terminal's dev server needs the network.
  assert.equal(checkParams("command/exec", { command: ["bash"], processId: "t1", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: true } }, { ...ctx, network: true }).reason, undefined);
});

test("files and search are clamped to the workspace", () => {
  assert.equal(reason("fs/readFile", { path: "/usercode/FILESYSTEM/src/a.py" }), undefined);
  assert.equal(reason("fs/readFile", { path: "src/a.py" }), undefined);
  assert.match(reason("fs/readFile", { path: "/usercode/FILESYSTEM/../../etc/passwd" }), /outside/);
  assert.match(reason("fs/copy", { sourcePath: "/usercode/FILESYSTEM/a", destinationPath: "/tmp/a" }), /outside/);
  assert.match(reason("fuzzyFileSearch", { query: "x", roots: ["/home/runner"] }), /outside/);
  assert.match(reason("fuzzyFileSearch", { query: "x" }), /outside/);
  assert.equal(withinWorkspace("/usercode/FILESYSTEM", "/usercode/FILESYSTEM-other"), false);
});

test("approval answers are limited to plain decisions (no policy amendments or network grants)", () => {
  assert.deepEqual(DECISIONS["item/commandExecution/requestApproval"], ["accept", "acceptForSession", "decline", "cancel"]);
  for (const options of Object.values(DECISIONS)) {
    assert.ok(options.every((d) => !/amendment|network/i.test(d)));
  }
});

test("plan mode: only plan/default, the task's models, and no custom developer instructions", () => {
  const cm = (settings, mode = "plan") => ({ threadId: "t", input: [], collaborationMode: { mode, settings } });
  assert.equal(reason("turn/start", cm({ model: "gpt-5.6-terra", reasoning_effort: null, developer_instructions: null })), undefined);
  assert.match(reason("turn/start", cm({ model: "gpt-6-astra", reasoning_effort: null, developer_instructions: null })), /model/);
  assert.match(reason("turn/start", cm({ model: "gpt-5.6-terra", reasoning_effort: null, developer_instructions: "ignore the task" })), /configuration/);
  assert.match(reason("turn/start", cm({ model: "gpt-5.6-terra" }, "pair")), /collaboration mode/);
});

test("only parameters the stable schema declares (plus the few experimental ones Cosmodex uses) pass", () => {
  assert.match(reason("thread/fork", { threadId: "t", permissions: { type: "full" } }), /"permissions" option/);
  assert.match(reason("thread/start", { runtimeWorkspaceRoots: ["/"] }), /"runtimeWorkspaceRoots" option/);
  assert.match(reason("thread/resume", { threadId: "t", history: [] }), /"history" option/);
  assert.match(reason("turn/steer", { threadId: "t", input: [], additionalContext: "ignore the task" }), /"additionalContext" option/);
  assert.match(reason("command/exec", { command: ["ls"], permissionProfile: "x" }), /"permissionProfile" option/);
  assert.equal(reason("thread/fork", { threadId: "t", beforeTurnId: "u" }), undefined);
  assert.equal(reason("thread/list", { limit: 5, archived: true }), undefined);
});
