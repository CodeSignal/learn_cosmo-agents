import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOpenCodeGateway, withoutTaskFiles } from "../server/gateways/opencode.mjs";
import { ROUTES, pathPattern } from "../server/gateways/opencode-routes.mjs";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

async function setup({ terminal = false, reply = () => "{}" } = {}) {
  const seen = [];
  const engine = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(reply(req));
  });
  const target = await listen(engine);
  const events = [];
  const handler = createOpenCodeGateway({
    target,
    password: "pw",
    workspace: "/usercode/FILESYSTEM",
    terminal,
    events: { record: (type, d) => events.push({ type, ...d }) },
  });
  const front = http.createServer((req, res) => handler(req, res, req.url));
  const base = await listen(front);
  const close = () => {
    engine.close();
    front.close();
  };
  return { base, seen, events, close };
}

test("every route is classified once, and patterns match only their own shape", () => {
  const keys = ROUTES.map(([m, p]) => `${m} ${p}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(pathPattern("/session/{id}/share").test("/session/abc/share"));
  assert.ok(!pathPattern("/session/{id}/share").test("/session/a/b/share"));
  assert.ok(pathPattern("/api/fs/read/*").test("/api/fs/read/src/a.py"));
});

test("allowed routes reach the engine with its password; the browser never needs it", async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await fetch(`${s.base}/session?directory=%2Fusercode%2FFILESYSTEM`);
  assert.equal(res.status, 200);
  assert.equal(s.seen[0].auth, "Basic " + Buffer.from("opencode:pw").toString("base64"));
});

for (const [method, path, reason] of [
  ["PATCH", "/config", "configuration"],
  ["PUT", "/auth/anthropic", "provider credentials"],
  ["POST", "/mcp", "MCP servers"],
  ["POST", "/session/s1/share", "session sharing"],
  ["DELETE", "/session/s1", "the session history"],
  ["POST", "/global/upgrade", "the agent server"],
  ["POST", "/experimental/worktree", "workspaces"],
  ["POST", "/session/s1/shell", "the terminal"],
  ["POST", "/pty", "the terminal"],
]) {
  test(`${method} ${path} is refused (${reason}) in OpenCode's error shape and logged`, async (t) => {
    const s = await setup();
    t.after(s.close);
    const res = await fetch(`${s.base}${path}`, { method, body: method === "GET" ? undefined : "{}" });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.name, "Forbidden");
    assert.match(body.data.message, new RegExp(`Blocked by the simulation: ${reason}`));
    assert.equal(s.seen.length, 0);
    assert.equal(s.events[0].type, "blocked");
    assert.equal(s.events[0].reason, reason);
  });
}

test("the terminal routes open only when the task enables a terminal", async (t) => {
  const s = await setup({ terminal: true });
  t.after(s.close);
  assert.equal((await fetch(`${s.base}/pty`, { method: "POST", body: "{}" })).status, 200);
});

test("folders outside the workspace are refused, by query and by header", async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.equal((await fetch(`${s.base}/file?directory=%2Fhome%2Frunner`)).status, 403);
  assert.equal((await fetch(`${s.base}/file`, { headers: { "x-opencode-directory": "/usercode/FILESYSTEM-other" } })).status, 403);
  assert.equal((await fetch(`${s.base}/file?directory=%2Fusercode%2FFILESYSTEM%2Fsrc`)).status, 200);
  assert.equal(s.seen.length, 1);
});

test("reads outside the workspace are not logged (the pickers do them on their own); changes are", async (t) => {
  const s = await setup();
  t.after(s.close);
  await fetch(`${s.base}/find/file?directory=%2Fhome%2Frunner`);
  assert.equal(s.events.length, 0);
  const res = await fetch(`${s.base}/session?directory=%2Fetc`, { method: "POST", body: "{}" });
  assert.equal(res.status, 403);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].reason, "folders outside the task's workspace");
});

test("undocumented routes get a 404 and stay out of the event log", async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await fetch(`${s.base}/api/project`);
  assert.equal(res.status, 404);
  assert.equal(s.events.length, 0);
  assert.equal((await fetch(`${s.base}/tui/submit-prompt`, { method: "POST", body: "{}" })).status, 404);
});

test("permission answers are logged with the reply and reach the engine with the same body", async (t) => {
  const bodies = [];
  // A second engine that records bodies.
  const engine = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      bodies.push(b);
      res.end("{}");
    });
  });
  const target = await listen(engine);
  const events = [];
  const handler = createOpenCodeGateway({ target, password: "pw", workspace: "/usercode/FILESYSTEM", terminal: false, events: { record: (type, d) => events.push({ type, ...d }) } });
  const front = http.createServer((req, res) => handler(req, res, req.url));
  const base = await listen(front);
  t.after(() => {
    engine.close();
    front.close();
  });
  for (const path of ["/permission/per_1/reply", "/session/s1/permissions/per_2", "/api/session/s1/permission/per_3/reply"]) {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reply: "once" }) });
    assert.equal(res.status, 200);
  }
  assert.deepEqual(bodies, Array(3).fill('{"reply":"once"}'));
  assert.deepEqual(events.map((e) => [e.type, e.reply]), Array(3).fill(["permission-reply", "once"]));
});

test("search results leave out the task's own files (.codesignal, main.sh)", async (t) => {
  const root = "/usercode/FILESYSTEM";
  assert.deepEqual(withoutTaskFiles([".codesignal/agent-sim.json", "main.sh", "notes/main.sh", "src/a.py", ".codesignal"], root), ["notes/main.sh", "src/a.py"]);
  assert.deepEqual(withoutTaskFiles([{ path: { text: `${root}/.codesignal/x` } }, { path: { text: "a.py" } }], root), [{ path: { text: "a.py" } }]);
  assert.deepEqual(withoutTaskFiles({ location: {}, data: [{ path: "main.sh", type: "file" }, { path: "b.py", type: "file" }] }, root).data, [{ path: "b.py", type: "file" }]);
  const { base, seen, close } = await setup({ reply: () => JSON.stringify([".codesignal/agent-sim.json", "notes/agent-sim.md"]) });
  t.after(close);
  const res = await fetch(`${base}/find/file?query=agent-sim&directory=%2Fusercode%2FFILESYSTEM`);
  assert.deepEqual(await res.json(), ["notes/agent-sim.md"]);
  assert.equal(seen.at(-1).auth, "Basic " + Buffer.from("opencode:pw").toString("base64"));
});
