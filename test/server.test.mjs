import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/index.mjs";
import { createEventLog } from "../server/events.mjs";
import { RouteGateway, proxyHttp } from "../server/gateway.mjs";
import { validateTaskConfig } from "../policy/schema.mjs";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const json = async (res) => ({ status: res.status, body: await res.json() });

function setup(raw, gateways) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "events-"));
  const events = createEventLog(dir);
  const policy = validateTaskConfig(raw).config;
  const server = createServer({ policy, events, gateways });
  const readEvents = () => fs.readFileSync(events.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { server, readEvents };
}

test("session lists only the task's agents, with the active one and switch setting", async (t) => {
  const { server } = setup({ agents: ["cosmodex", "cosmo-code"], allowSwitch: true });
  const base = await listen(server);
  t.after(() => server.close());
  const { body } = await json(await fetch(`${base}/api/session`));
  assert.deepEqual(body.agents.map((a) => a.id), ["cosmodex", "cosmo-code"]);
  assert.equal(body.active, "cosmodex");
  assert.equal(body.allowSwitch, true);
  assert.equal(body.agents[0].available, false);
});

test("the session tells OpenCosmo the starting level when the task limits levels", async (t) => {
  const { server } = setup({ agents: ["opencosmo", "cosmodex"], models: { opencosmo: { efforts: ["low", "medium"] }, cosmodex: { efforts: ["low", "medium"] } } });
  const base = await listen(server);
  t.after(() => server.close());
  const { body } = await json(await fetch(`${base}/api/session`));
  assert.deepEqual(body.agents.map((a) => a.startEffort), ["low", undefined]);
});

test("switching is refused and logged when the task disallows it", async (t) => {
  const { server, readEvents } = setup({ agents: ["cosmodex", "cosmo-code"] });
  const base = await listen(server);
  t.after(() => server.close());
  const res = await json(await fetch(`${base}/api/switch`, { method: "POST", body: JSON.stringify({ agent: "cosmo-code" }) }));
  assert.equal(res.status, 403);
  assert.equal(res.body.blocked, true);
  const blocked = readEvents().find((e) => e.type === "blocked");
  assert.equal(blocked.action, "switch");
  assert.equal(blocked.reason, "switching disabled");
});

test("switching between enabled agents is logged; a disabled agent is refused", async (t) => {
  const { server, readEvents } = setup({ agents: ["cosmodex", "cosmo-code"], allowSwitch: true });
  const base = await listen(server);
  t.after(() => server.close());
  const ok = await json(await fetch(`${base}/api/switch`, { method: "POST", body: JSON.stringify({ agent: "cosmo-code" }) }));
  assert.equal(ok.body.active, "cosmo-code");
  const no = await fetch(`${base}/api/switch`, { method: "POST", body: JSON.stringify({ agent: "opencosmo" }) });
  assert.equal(no.status, 403);
  const types = readEvents().map((e) => e.type);
  assert.deepEqual(types, ["session-start", "switch", "blocked"]);
});

test("engine routes: disabled agent 403, missing gateway 503, gateway gets the sub-path and query", async (t) => {
  const seen = [];
  const { server } = setup({ agents: ["opencosmo", "cosmodex"] }, {
    opencosmo: (req, res, sub) => {
      seen.push(sub);
      res.end("ok");
    },
  });
  const base = await listen(server);
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/engine/cosmo-code/x`)).status, 403);
  assert.equal((await fetch(`${base}/engine/cosmodex/x`)).status, 503);
  assert.equal(await (await fetch(`${base}/engine/opencosmo/session/1?x=2`)).text(), "ok");
  assert.deepEqual(seen, ["/session/1?x=2"]);
});

test("route gateway: first match wins, default deny, refusals logged", () => {
  const recorded = [];
  const gw = new RouteGateway({
    name: "t",
    events: { record: (type, d) => recorded.push({ type, ...d }) },
    rules: [
      { method: "*", path: /^\/config/, allow: false, reason: "config is locked" },
      { method: "GET", path: /^\/session/ },
    ],
  });
  assert.deepEqual(gw.decide("GET", "/session/1"), { allow: true, reason: undefined });
  assert.equal(gw.decide("PATCH", "/config").allow, false);
  assert.equal(gw.decide("POST", "/session/1").allow, false);
  const res = { writeHead() {}, end(b) { this.body = b; } };
  gw.block(res, { method: "PATCH", pathname: "/config", reason: "config is locked", agent: "opencosmo" });
  assert.equal(JSON.parse(res.body).blocked, true);
  assert.equal(recorded[0].type, "blocked");
});

test("proxyHttp streams SSE through and injects upstream headers", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${req.headers.authorization}\n\n`);
    setTimeout(() => res.end("data: done\n\n"), 50);
  });
  const target = await listen(upstream);
  const front = http.createServer((req, res) => proxyHttp(req, res, { target, path: "/event", headers: { authorization: "Basic abc" } }));
  const base = await listen(front);
  t.after(() => {
    upstream.close();
    front.close();
  });
  const text = await (await fetch(base)).text();
  assert.equal(text, "data: Basic abc\n\ndata: done\n\n");
});

test("requests that change something are refused from other sites and sandboxed pages", async (t) => {
  const { server, readEvents } = setup({ agents: ["cosmodex", "cosmo-code"], allowSwitch: true });
  const base = await listen(server);
  t.after(() => server.close());
  const post = (headers) => fetch(`${base}/api/switch`, { method: "POST", headers, body: JSON.stringify({ agent: "cosmo-code" }) });
  assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await post({ origin: "null" })).status, 403);
  assert.equal((await post({ "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await post({})).status, 200);
  assert.equal((await fetch(`${base}/api/session`, { headers: { "sec-fetch-site": "cross-site" } })).status, 200);
  assert.ok(readEvents().some((e) => e.type === "blocked" && e.action === "cross-site request"));
});

test("the preview serves workspace files sandboxed, and nothing outside the workspace or hidden", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  fs.mkdirSync(path.join(workspace, "site"));
  fs.writeFileSync(path.join(workspace, "site", "index.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(workspace, "doc.pdf"), "%PDF-1.4");
  fs.writeFileSync(path.join(workspace, "notes.py"), "print(1)");
  fs.mkdirSync(path.join(workspace, ".codesignal"));
  fs.writeFileSync(path.join(workspace, ".codesignal", "agent-sim.html"), "secret");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  fs.writeFileSync(path.join(outside, "x.html"), "outside");
  fs.symlinkSync(path.join(outside, "x.html"), path.join(workspace, "link.html"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "events-"));
  const server = createServer({ policy: validateTaskConfig({ agents: ["cosmo-code"] }).config, events: createEventLog(dir), workspace });
  const base = await listen(server);
  t.after(() => server.close());
  const { preview } = await (await fetch(`${base}/api/session`)).json();
  assert.match(preview, /^\/_cosmo\/api\/workspace\/preview\/[0-9a-f]{32}\/$/);
  // Without the session's token there's nothing to load.
  assert.equal((await fetch(`${base}/api/workspace/preview/site/index.html`)).status, 404);
  const get = (p) => fetch(`${base}${preview}${p}`);
  const page = await get("site/index.html");
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<h1>hi</h1>");
  assert.match(page.headers.get("content-security-policy"), /^sandbox allow-scripts/);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  const pdf = await get("doc.pdf");
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(pdf.headers.get("content-security-policy"), null);
  assert.equal((await get("notes.py")).status, 415);
  for (const p of ["link.html", ".codesignal/agent-sim.html", "..%2F..%2Fetc%2Fpasswd", "%2E%2E/x.html", "missing.html", "site"]) assert.equal((await get(p)).status, p === "site" ? 415 : 404, p);
});

test("a task app: the simulation's routes move under /_cosmo, everything else reaches the app", async (t) => {
  const seen = [];
  const app = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin });
    res.writeHead(200, { "content-type": "text/plain", "service-worker-allowed": "/" });
    res.end(`app:${req.url}`);
  });
  const appBase = await listen(app);
  const port = Number(new URL(appBase).port);
  const { server } = setup({ agents: ["cosmo-code"], app: { port } });
  const base = await listen(server);
  t.after(() => (server.close(), app.close()));

  const session = await json(await fetch(`${base}/_cosmo/api/session`));
  assert.deepEqual(session.body.app, { path: "/app/", port });
  assert.match(session.body.preview, /^\/_cosmo\/api\/workspace\/preview\//);
  // The app's own paths, and absolute paths its code uses without the base, go to the app.
  const page = await fetch(`${base}/app/?x=1`, { headers: { origin: "https://preview.example" } });
  assert.equal(await page.text(), "app:/app/?x=1");
  assert.equal(page.headers.get("service-worker-allowed"), null);
  assert.equal(await (await fetch(`${base}/data/lots.json`)).text(), "app:/app/data/lots.json");
  assert.equal(await (await fetch(`${base}/api/session`)).text(), "app:/app/api/session");
  assert.deepEqual(seen[0], { url: "/app/?x=1", host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` });
  // The shell's page stays at /.
  assert.notEqual(await (await fetch(`${base}/`)).text(), "app:/app/");
});

test("a task app that isn't running yet gets a page saying how to start it", async (t) => {
  const probe = http.createServer();
  const port = Number(new URL(await listen(probe)).port);
  await new Promise((r) => probe.close(r));
  const { server } = setup({ agents: ["cosmo-code"], app: { port } });
  const base = await listen(server);
  t.after(() => server.close());
  const res = await fetch(`${base}/app/`, { headers: { accept: "text/html" } });
  assert.equal(res.status, 502);
  assert.match(await res.text(), new RegExp(`Nothing is running on port <code>${port}</code>`));
});

test("without a task app, the routes answer with and without /_cosmo", async (t) => {
  const { server } = setup({ agents: ["cosmo-code"] });
  const base = await listen(server);
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/_cosmo/api/health`)).status, 200);
  assert.equal((await json(await fetch(`${base}/_cosmo/api/session`))).body.app, null);
});
