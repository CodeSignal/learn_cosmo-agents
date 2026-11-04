// OpenCosmo's gateway to `opencode serve` on loopback: allowlisted routes only, every folder
// clamped to the task workspace, the engine's password injected so the browser never sees it.
import { RouteGateway, proxyHttp, proxyUpgrade, readBody } from "../gateway.mjs";
import { ROUTES, pathPattern } from "./opencode-routes.mjs";
import { createTurnRecorder } from "../turns.mjs";
import { createTranscript } from "../transcript.mjs";

const TERMINAL_REASON = "the terminal";

// The routes that answer a permission prompt (v1, legacy and v2 API).
const PERMISSION_REPLY = [
  /^\/permission\/[^/]+\/reply$/,
  /^\/session\/[^/]+\/permissions\/[^/]+$/,
  /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/,
];

// File and text search (v1 and v2 API). What the supervisor git-excludes (the task's own files,
// installed dependencies, build output) stays out of their results; OpenCode 1.19 no longer reads
// git's exclude file for its search.
const SEARCH = ["/find/file", "/find", "/api/fs/find"];
const EXCLUDED = /^(\.codesignal(\/|$)|main\.sh$|(\.venv|node_modules|dist|\.cache)(\/|$))/;

/** A search result without git-excluded paths: path lists, text matches or v2 entries. */
export function withoutExcluded(result, root) {
  const rel = (p) => (typeof p === "string" ? p.replace(/^\.\//, "").replace(root + "/", "") : "");
  const keep = (x) => !EXCLUDED.test(rel(typeof x === "string" ? x : (x?.path?.text ?? x?.path)));
  if (Array.isArray(result)) return result.filter(keep);
  if (Array.isArray(result?.data)) return { ...result, data: result.data.filter(keep) };
  return result;
}

/** once / always / reject, from any of the reply shapes; null if unreadable. */
function replyOf(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    const value = parsed.reply ?? parsed.response ?? parsed.decision;
    return typeof value === "string" ? value.slice(0, 32) : null;
  } catch {
    return null;
  }
}

/** The turn record from OpenCode's own event stream: a user message's text is the prompt (with its
 * model and agent), finished tool parts are tool use, and the session failing or going idle ends
 * the turn under way (a failed turn goes idle too; sessions also go idle without a turn). */
export function opencodeTurns(turns) {
  const users = new Map(); // user message id → { model, mode }, until its text arrives
  const seen = new Set(); // tool calls already counted
  return (event) => {
    const p = event?.properties ?? {};
    switch (event?.type) {
      case "message.updated":
        if (p.info?.role === "user" && !seen.has(p.info.id)) users.set(p.info.id, { model: p.info.model?.modelID, mode: p.info.agent });
        else if (p.info?.role === "assistant") turns.settings(p.info.sessionID, { model: p.info.modelID, mode: p.info.mode });
        return;
      case "message.part.updated": {
        const part = p.part ?? {};
        if (part.type === "text" && !part.synthetic && users.has(part.messageID)) {
          const user = users.get(part.messageID);
          users.delete(part.messageID);
          seen.add(part.messageID);
          turns.start(part.sessionID, { prompt: part.text, ...user });
        } else if (part.type === "tool" && ["completed", "error"].includes(part.state?.status) && !seen.has(part.callID)) {
          seen.add(part.callID);
          turns.tool(part.sessionID, part.tool);
        }
        return;
      }
      case "session.idle":
        if (turns.isOpen(p.sessionID)) turns.end(p.sessionID, "completed");
        return;
      case "session.error":
        if (turns.isOpen(p.sessionID)) turns.end(p.sessionID, p.error?.name === "MessageAbortedError" ? "interrupted" : "failed");
        return;
    }
  };
}

const FILE_TOOLS = { edit: "ai_edit", patch: "ai_edit", multiedit: "ai_edit", write: "ai_write" };

/** The transcript record (server/transcript.mjs) from OpenCode's event stream. A reply's text is
 * recorded when the reply completes (text parts stream in as updates). */
export function opencodeTranscript(t) {
  const users = new Set(); // user message ids
  const texts = new Map(); // assistant message id → Map(part id → text)
  const done = new Set(); // tool calls and replies already recorded
  return (event) => {
    const p = event?.properties ?? {};
    const info = p.info ?? {};
    switch (event?.type) {
      case "message.updated":
        if (info.role === "user") {
          users.add(info.id);
          t.model(info.sessionID, info.model?.modelID);
          t.mode(info.sessionID, info.agent);
        } else if (info.role === "assistant" && info.time?.completed && !done.has(info.id)) {
          done.add(info.id);
          t.model(info.sessionID, info.modelID);
          for (const text of texts.get(info.id)?.values() ?? []) t.text(info.sessionID, text);
          texts.delete(info.id);
          const k = info.tokens;
          if (k) t.tokens(info.sessionID, { input_tokens: k.input, output_tokens: k.output, reasoning_output_tokens: k.reasoning, cached_input_tokens: k.cache?.read });
        }
        return;
      case "message.part.updated": {
        const part = p.part ?? {};
        if (part.type === "text" && !part.synthetic) {
          if (users.has(part.messageID)) {
            if (!done.has(part.messageID)) (done.add(part.messageID), t.prompt(part.sessionID, part.text));
          } else {
            if (!texts.has(part.messageID)) texts.set(part.messageID, new Map());
            texts.get(part.messageID).set(part.id, part.text);
          }
        } else if (part.type === "tool" && ["completed", "error"].includes(part.state?.status) && !done.has(part.callID)) {
          done.add(part.callID);
          const input = part.state.input ?? {};
          t.tool(part.sessionID, { callId: part.callID, name: part.tool });
          if (part.tool === "bash") t.command(part.sessionID, { command: input.command, output: part.state.output ?? undefined });
          if (FILE_TOOLS[part.tool]) t.file(part.sessionID, { path: input.filePath, action: FILE_TOOLS[part.tool] });
          t.result(part.sessionID, { callId: part.callID, name: part.tool, isError: part.state.status === "error", errorText: part.state.error });
        }
        return;
      }
      case "session.idle":
        t.end(p.sessionID);
        return;
    }
  };
}

/** Follow OpenCode's event stream for the workspace (reconnecting), handing each event on. */
function followEvents({ target, headers, root, onEvent }) {
  let delay = 1000;
  const connect = async () => {
    try {
      const url = new URL(`/event?directory=${encodeURIComponent(root)}`, target);
      const res = await fetch(url, { headers: { ...headers, accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      delay = 1000;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const data = buffer.slice(0, at).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          buffer = buffer.slice(at + 2);
          if (!data) continue;
          try {
            onEvent(JSON.parse(data));
          } catch (error) {
            console.error(`opencode: turn record: ${error.message}`);
          }
        }
      }
    } catch {
      /* the engine is (re)starting */
    }
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 15000);
  };
  connect();
}

/**
 * @param watch  follow the engine's event stream for the turn record (off in unit tests)
 */
export function createOpenCodeGateway({ target, password, workspace, terminal, events, agent = "opencosmo", watch = false, transcripts }) {
  const rules = ROUTES.map(([method, path, decision]) => ({
    method,
    path: pathPattern(path),
    allow: decision === "allow" || (decision === "terminal" && terminal),
    reason: decision === "terminal" ? TERMINAL_REASON : decision,
  }));
  const gateway = new RouteGateway({ name: "opencode", rules, events });
  const auth = password ? { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") } : {};
  const root = workspace.replace(/\/+$/, "");
  if (watch) {
    const turns = opencodeTurns(createTurnRecorder({ events, gateway: "opencode", agent }));
    const transcript = opencodeTranscript(createTranscript({ dir: transcripts && `${transcripts}/opencode`, agent, project: root }));
    followEvents({ target, headers: auth, root, onEvent: (e) => {
      for (const on of [turns, transcript]) {
        try {
          on(e);
        } catch {
          /* a record never breaks the stream */
        }
      }
    } });
  }

  // Folders arrive as ?directory= and the x-opencode-directory header.
  const outside = (req, url) =>
    [url.searchParams.get("directory"), req.headers["x-opencode-directory"]]
      .filter(Boolean)
      .map((d) => {
        try {
          return decodeURIComponent(d);
        } catch {
          return d;
        }
      })
      .some((d) => d !== root && !d.startsWith(root + "/"));

  const check = (req, method, sub) => {
    const url = new URL(sub, "http://engine");
    const verdict = gateway.decide(method, url.pathname);
    if (!verdict.allow) return { pathname: url.pathname, reason: verdict.reason, unknown: verdict.unknown };
    // The folder pickers list the home folder by themselves; reads outside the workspace are
    // refused without an event, changes are refused and logged.
    if (outside(req, url)) return { pathname: url.pathname, reason: "folders outside the task's workspace", quiet: method === "GET" };
    return null;
  };

  // OpenCode's own error shape, so the UI shows the refusal as a normal toast.
  gateway.blockBody = (reason) => ({ name: "Forbidden", data: { message: `Blocked by the simulation: ${reason} can't be changed here.` } });

  const handler = async (req, res, sub) => {
    const refused = check(req, req.method, sub);
    if (refused?.unknown) return gateway.notFound(res, { method: req.method, pathname: refused.pathname });
    if (refused) return gateway.block(res, { method: req.method, agent, ...refused });
    const pathname = new URL(sub, "http://engine").pathname;
    if (req.method === "POST" && PERMISSION_REPLY.some((re) => re.test(pathname))) {
      // How the candidate answered a permission prompt is part of what Cosmo reviews.
      let body;
      try {
        body = await readBody(req);
      } catch {
        return gateway.block(res, { method: req.method, agent, pathname, reason: "an oversized request" });
      }
      events?.record("permission-reply", { gateway: "opencode", agent, path: pathname, reply: replyOf(body) });
      return proxyHttp(req, res, { target, path: sub, headers: auth, body });
    }
    if (req.method === "GET" && SEARCH.includes(pathname)) return search(req, res, sub);
    proxyHttp(req, res, { target, path: sub, headers: auth });
  };
  const search = async (req, res, sub) => {
    try {
      const dir = req.headers["x-opencode-directory"];
      const up = await fetch(new URL(sub, target), { headers: { ...auth, ...(dir ? { "x-opencode-directory": dir } : {}) } });
      let body = await up.text();
      try {
        body = JSON.stringify(withoutExcluded(JSON.parse(body), root));
      } catch {
        /* not JSON: as the engine sent it */
      }
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `engine unavailable: ${e.code || e.message}` }));
    }
  };
  handler.upgrade = (req, socket, head, sub) => {
    const refused = check(req, "GET", sub);
    if (refused) {
      events?.record("blocked", { gateway: "opencode", agent, method: "UPGRADE", path: refused.pathname, reason: refused.reason });
      return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
    proxyUpgrade(req, socket, head, { target, path: sub, headers: auth });
  };
  return handler;
}
