// A gateway to an engine that speaks JSON-RPC over a loopback WebSocket (codex app-server, the
// Cosmo Code engine host), run by the supervisor as the session user. The browser never talks to
// the engine: it calls methods with POST /rpc, receives notifications and engine requests
// (approvals, questions) over SSE /events, and answers those with POST /respond. Each engine's
// gateway supplies what passes: which methods, which parameters, which answers.
import { RouteGateway, readBody } from "../gateway.mjs";

export const blockedError = (reason) => ({ code: -32001, message: `Blocked by the simulation: ${reason} can't be changed here.`, data: { blocked: true } });

/** A JSON-RPC connection to the engine that reconnects (and re-runs the handshake) when it drops. */
export class EngineLink {
  /**
   * @param handshake  { method, params, notify? }: the first request on every connection, and the
   *                   notification sent once it succeeds (e.g. "initialized")
   */
  constructor({ url, handshake, onMessage, onState }) {
    this.url = url;
    this.handshake = handshake;
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
        resolve: (result) => {
          if (this.handshake.notify) this.send({ jsonrpc: "2.0", method: this.handshake.notify });
          this.info = result;
          this.ready = true;
          this.onState("ready");
          for (const msg of this.queue.splice(0)) this.send(msg);
        },
        reject: () => ws.close(),
      });
      this.send({ jsonrpc: "2.0", id, method: this.handshake.method, params: this.handshake.params });
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

/**
 * @param name        the gateway's name in the event log ("codex", "claude")
 * @param agent       the agent id; the engine state goes out as `<agent>/engine`
 * @param methods     method → "allow" | "terminal" | the reason it's refused (unlisted: not found)
 * @param terminal    whether "terminal" methods are allowed
 * @param check       async (method, params, link) → { params } | { reason }
 * @param ask         (engine request) → true to put it to the candidate, or the reason to refuse it
 * @param answer      (asked request, the browser's result) → { result, reply? } | { reason }
 * @param resolvedId  (notification) → the id of an engine request the engine withdrew, if any
 * @param observe     { call(method, params, result), notify(msg) }: sees every call the engine
 *                    answered and every notification (the turn record)
 */
/** Several observers as one; one that throws doesn't stop the others. */
export function observers(...list) {
  const each = (fn) => list.forEach((o) => {
    try {
      fn(o);
    } catch {
      /* an observer never breaks the gateway */
    }
  });
  return { call: (...a) => each((o) => o?.call?.(...a)), notify: (m) => each((o) => o?.notify?.(m)) };
}

export function createJsonRpcGateway({ name, agent, url, handshake, methods, terminal = false, check, ask, answer, resolvedId = () => undefined, observe, events }) {
  const gateway = new RouteGateway({ name, rules: [], events });
  const clients = new Set();
  // Engine requests awaiting the candidate, keyed by String(id): the browser may send the id back as
  // a string; the engine is always answered with its own id.
  const openRequests = new Map();
  const broadcast = (msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(line);
  };
  const record = (type, detail) => events?.record(type, { gateway: name, agent, ...detail });
  // The record never gets in the way of the engine's traffic.
  const watch = (fn) => {
    try {
      fn();
    } catch (error) {
      console.error(`${name}: turn record: ${error.message}`);
    }
  };

  const link = new EngineLink({
    url,
    handshake,
    onState: (state) => broadcast({ method: `${agent}/engine`, params: { state } }),
    onMessage: (msg) => {
      if (msg.id !== undefined && msg.method) {
        // The engine asks the candidate something.
        const verdict = ask(msg);
        if (verdict === true) {
          openRequests.set(String(msg.id), msg);
          return broadcast(msg);
        }
        record("blocked", { method: msg.method, reason: verdict });
        return link.answer(msg.id, undefined, blockedError(verdict));
      }
      const withdrawn = resolvedId(msg);
      if (withdrawn !== undefined) openRequests.delete(String(withdrawn));
      watch(() => observe?.notify?.(msg));
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
    const decision = typeof method === "string" && Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (decision === undefined) {
      console.warn(`${name}: unrouted method ${String(method).slice(0, 80)}`);
      return send(res, 404, { error: { code: -32601, message: "Method not found" } });
    }
    const allowed = decision === "allow" || (decision === "terminal" && terminal);
    const checked = allowed ? await check(method, params, link) : { reason: decision === "terminal" ? "the terminal" : decision };
    if (checked.reason) {
      record("blocked", { method, reason: checked.reason });
      return send(res, 403, { error: blockedError(checked.reason) });
    }
    try {
      const result = await link.request(method, checked.params);
      watch(() => observe?.call?.(method, checked.params, result));
      send(res, 200, { result });
    } catch (error) {
      send(res, 200, { error });
    }
  }

  async function respond(req, res) {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      return send(res, 400, { error: { code: -32700, message: "Parse error" } });
    }
    const asked = openRequests.get(String(body?.id));
    if (!asked) return send(res, 404, { error: { code: -32602, message: "No open request with that id" } });
    const verdict = answer(asked, body.result ?? {});
    if (verdict.reason) {
      record("blocked", { method: asked.method, reason: verdict.reason });
      return send(res, 403, { error: blockedError(verdict.reason) });
    }
    if (verdict.reply !== undefined) record("permission-reply", { method: asked.method, reply: verdict.reply });
    openRequests.delete(String(asked.id));
    link.answer(asked.id, verdict.result, undefined);
    send(res, 200, {});
  }

  const handler = (req, res, sub) => {
    const { pathname } = new URL(sub, "http://engine");
    if (req.method === "GET" && pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ method: `${agent}/engine`, params: { state: link.ready ? "ready" : "connecting" } })}\n\n`);
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
