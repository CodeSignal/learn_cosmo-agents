// Cosmodex's gateway to `codex app-server` (JSON-RPC over a loopback WebSocket, run by the
// supervisor as the session user). The browser never talks to the engine: it calls methods with
// POST /rpc, receives notifications and engine requests (approvals, questions) over SSE /events,
// and answers those with POST /respond. Only classified methods pass, and their parameters are
// checked against what the task allows.
import path from "node:path";
import { RouteGateway, readBody } from "../gateway.mjs";
import { METHODS, DECISIONS, USER_INPUT, CODEX_VERSION } from "./codex-methods.mjs";

const SANDBOX_TYPES = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
// Parameters a candidate's UI never needs and that would change how the engine is set up.
const SETUP_KEYS = ["modelProvider", "config", "baseInstructions", "developerInstructions", "serviceTier", "serviceTierForTurn", "serviceName"];
const THREAD_SETUP = new Set(["thread/start", "thread/resume", "thread/fork"]);

/** Whether `p` is the workspace or inside it (relative paths resolve against it). */
export function withinWorkspace(workspace, p) {
  if (typeof p !== "string" || !p) return false;
  const resolved = path.posix.resolve(workspace, p);
  return resolved === workspace || resolved.startsWith(workspace + "/");
}

/**
 * Check a call's parameters against the task. Returns { params } (possibly with the workspace
 * pinned as cwd) or { reason } when the call asks for something the task doesn't allow.
 */
export function checkParams(method, params = {}, ctx) {
  const p = params && typeof params === "object" ? { ...params } : {};
  const has = (k) => p[k] !== undefined && p[k] !== null;
  const inside = (v) => withinWorkspace(ctx.workspace, v);

  if (THREAD_SETUP.has(method) || method === "turn/start" || method === "command/exec") {
    for (const key of SETUP_KEYS) if (has(key)) return { reason: CONFIG_REASON(key) };
    if (has("approvalsReviewer") && p.approvalsReviewer !== "user") return { reason: "the approval reviewer" };
    if (has("model") && !ctx.models.includes(p.model)) return { reason: `the model (${String(p.model).slice(0, 40)} isn't available in this task)` };
    if (has("approvalPolicy") && !(typeof p.approvalPolicy === "string" && ctx.approvalPolicies.includes(p.approvalPolicy))) {
      return { reason: "the approval policy" };
    }
    if (has("sandbox") && !ctx.sandboxModes.includes(p.sandbox)) return { reason: "the sandbox" };
    if (has("sandboxPolicy")) {
      const sp = p.sandboxPolicy;
      const mode = SANDBOX_TYPES[sp?.type];
      if (!mode || !ctx.sandboxModes.includes(mode)) return { reason: "the sandbox" };
      if (sp.networkAccess) return { reason: "network access" };
      if ((sp.writableRoots ?? []).some((r) => !inside(r))) return { reason: "folders outside the task's workspace" };
    }
    if (has("cwd") && !inside(p.cwd)) return { reason: "folders outside the task's workspace" };
    if (THREAD_SETUP.has(method) && !has("cwd")) p.cwd = ctx.workspace;
  }
  if (method === "turn/start" || method === "turn/steer") {
    for (const item of Array.isArray(p.input) ? p.input : []) {
      if ((item?.type === "localImage" || item?.type === "localAudio") && !inside(item.path)) {
        return { reason: "files outside the task's workspace" };
      }
    }
  }
  if (method.startsWith("fs/")) {
    for (const key of ["path", "sourcePath", "destinationPath"]) {
      if (has(key) && !inside(p[key])) return { reason: "files outside the task's workspace" };
    }
  }
  if (method === "fuzzyFileSearch" && (!Array.isArray(p.roots) || p.roots.some((r) => !inside(r)))) {
    return { reason: "folders outside the task's workspace" };
  }
  if (method === "config/read" && has("cwd") && !inside(p.cwd)) return { reason: "folders outside the task's workspace" };
  return { params: p };
}

const CONFIG_REASON = (key) => (key.startsWith("serviceTier") || key === "serviceName" ? "the service tier" : "configuration");

/** A JSON-RPC connection to app-server that reconnects (and re-initializes) when it drops. */
class EngineLink {
  constructor({ url, onMessage, onState }) {
    this.url = url;
    this.onMessage = onMessage;
    this.onState = onState;
    this.nextId = 1;
    this.pending = new Map();
    this.queue = [];
    this.ready = false;
    this.connect();
  }

  connect() {
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    // Node's WebSocket can sit in CONNECTING forever when nothing listens yet (the engine starts
    // alongside the server), so an attempt that hasn't opened in time is dropped and retried.
    const opening = setTimeout(() => {
      if (ws.readyState === 1) return;
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* never opened */
      }
      this.retry();
    }, 3000);
    ws.addEventListener("open", () => {
      clearTimeout(opening);
      const id = `init-${this.nextId++}`;
      this.pending.set(id, {
        resolve: () => {
          this.send({ jsonrpc: "2.0", method: "initialized" });
          this.ready = true;
          this.onState("ready");
          for (const msg of this.queue.splice(0)) this.send(msg);
        },
        reject: () => ws.close(),
      });
      this.send({ jsonrpc: "2.0", id, method: "initialize", params: { clientInfo: { name: "cosmodex", title: "Cosmodex", version: CODEX_VERSION } } });
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && !msg.method && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        return msg.error ? reject(msg.error) : resolve(msg.result);
      }
      this.onMessage(msg);
    });
    ws.addEventListener("close", () => {
      clearTimeout(opening);
      if (this.ws !== ws) return;
      this.ready = false;
      for (const [id, { reject }] of this.pending) {
        this.pending.delete(id);
        reject({ code: -32000, message: "The agent restarted; try again." });
      }
      this.onState("reconnecting");
      this.retry();
    });
    ws.addEventListener("error", () => {});
  }

  retry() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), 1000);
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ready) this.send(msg);
      else this.queue.push(msg);
    });
  }

  answer(id, result, error) {
    this.send(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
  }
}

const blockedError = (reason) => ({ code: -32001, message: `Blocked by the simulation: ${reason} can't be changed here.`, data: { blocked: true } });

export function createCodexGateway({ url, workspace, terminal, ceilings, events, agent = "cosmodex" }) {
  const ctx = { workspace: workspace.replace(/\/+$/, ""), ...ceilings };
  const gateway = new RouteGateway({ name: "codex", rules: [], events });
  const clients = new Set();
  // Engine requests awaiting the candidate, keyed by String(id): the browser may send the id back as
  // a string; the engine is always answered with its own id.
  const openRequests = new Map();
  const broadcast = (msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(line);
  };
  const refuseRequest = (msg, reason) => {
    events?.record("blocked", { gateway: "codex", agent, method: msg.method, reason });
    link.answer(msg.id, undefined, blockedError(reason));
  };

  const link = new EngineLink({
    url,
    onState: (state) => broadcast({ method: "cosmodex/engine", params: { state } }),
    onMessage: (msg) => {
      if (msg.id !== undefined && msg.method) {
        // The engine asks the candidate something.
        if (DECISIONS[msg.method] || USER_INPUT.has(msg.method)) {
          openRequests.set(String(msg.id), msg);
          return broadcast(msg);
        }
        if (msg.method === "item/permissions/requestApproval") return refuseRequest(msg, "extra permissions");
        return refuseRequest(msg, msg.method.startsWith("account/") ? "signing in" : "this request");
      }
      if (msg.method === "serverRequest/resolved") openRequests.delete(String(msg.params?.requestId));
      broadcast(msg);
    },
  });

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function rpc(req, res) {
    let call;
    try {
      call = JSON.parse((await readBody(req, 16 * 1024 * 1024)).toString("utf8"));
    } catch {
      return send(res, 400, { error: { code: -32700, message: "Parse error" } });
    }
    const { method, params } = call ?? {};
    const decision = typeof method === "string" ? METHODS[method] : undefined;
    if (decision === undefined) {
      console.warn(`codex: unrouted method ${String(method).slice(0, 80)}`);
      return send(res, 404, { error: { code: -32601, message: "Method not found" } });
    }
    const allowed = decision === "allow" || (decision === "terminal" && terminal);
    const reason = allowed ? checkParams(method, params, ctx).reason : decision === "terminal" ? "the terminal" : decision;
    if (reason) {
      events?.record("blocked", { gateway: "codex", agent, method, reason });
      return send(res, 403, { error: blockedError(reason) });
    }
    try {
      const result = await link.request(method, checkParams(method, params, ctx).params);
      send(res, 200, { result });
    } catch (error) {
      send(res, 200, { error });
    }
  }

  async function respond(req, res) {
    let answer;
    try {
      answer = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      return send(res, 400, { error: { code: -32700, message: "Parse error" } });
    }
    const asked = openRequests.get(String(answer?.id));
    if (!asked) return send(res, 404, { error: { code: -32602, message: "No open request with that id" } });
    if (DECISIONS[asked.method]) {
      const value = answer.result?.decision;
      if (!DECISIONS[asked.method].includes(value)) {
        events?.record("blocked", { gateway: "codex", agent, method: asked.method, reason: "this approval option" });
        return send(res, 403, { error: blockedError("this approval option") });
      }
      events?.record("permission-reply", { gateway: "codex", agent, method: asked.method, reply: value });
    }
    openRequests.delete(String(asked.id));
    // Only the decision itself goes to the engine; free-form answers (questions) pass as given.
    link.answer(asked.id, DECISIONS[asked.method] ? { decision: answer.result.decision } : (answer.result ?? {}), undefined);
    send(res, 200, {});
  }

  const handler = (req, res, sub) => {
    const { pathname } = new URL(sub, "http://engine");
    if (req.method === "GET" && pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ method: "cosmodex/engine", params: { state: link.ready ? "ready" : "connecting" } })}\n\n`);
      for (const msg of openRequests.values()) res.write(`data: ${JSON.stringify(msg)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && pathname === "/rpc") return rpc(req, res);
    if (req.method === "POST" && pathname === "/respond") return respond(req, res);
    gateway.notFound(res, { method: req.method, pathname });
  };
  handler.link = link;
  return handler;
}
