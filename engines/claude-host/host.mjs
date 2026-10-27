// The Cosmo Code engine host: the pinned Claude Code engine (driven through the Agent SDK) behind
// a small JSON-RPC protocol on a loopback WebSocket. The supervisor runs it as the session user,
// like the other engines; the server's gateway is its only client and decides what may pass.
// Everything about how the engine is set up is fixed here — binary, folder, setting sources — and
// the task's limits come from /etc/claude-code/managed-settings.json, which the engine enforces.
//
// Client → host:  initialize · session/list · session/read · session/send · session/interrupt ·
//                 session/configure · session/rename · session/fork · session/archive ·
//                 session/rewindFiles · session/context · session/close
// Host → client:  session/message {sessionId, message}   every SDK message, as it arrives
//                 session/state {sessionId, state}       "running" | "idle"
//                 session/permission (request)           the engine asks before using a tool
//                 session/permissionCancelled {id}       a pending ask the engine dropped
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { query, listSessions, getSessionMessages, getSessionInfo, renameSession, forkSession, tagSession } from "@anthropic-ai/claude-agent-sdk";

const PORT = Number(process.env.COSMO_CODE_PORT ?? 4600);
const TOKEN = process.env.COSMO_CODE_TOKEN ?? "";
const WORKSPACE = process.env.WORKSPACE ?? "/usercode/FILESYSTEM";
const CLAUDE = process.env.CLAUDE_BIN ?? "/usr/bin/claude";
// Defence in depth: the gateway checks these too, and the managed settings forbid bypass.
const MODES = new Set(["default", "acceptEdits", "plan"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const ARCHIVED = "archived";
// Plan mode writes the plan to a file here; ExitPlanMode itself carries no plan.
const PLANS = path.join(os.homedir(), ".claude", "plans");
const MAX_PLAN = 200_000;

if (!TOKEN) {
  console.error("COSMO_CODE_TOKEN is required");
  process.exit(2);
}

/** Options every session gets; only model, permission mode and effort vary. */
const base = () => ({
  pathToClaudeCodeExecutable: CLAUDE,
  cwd: WORKSPACE,
  // As in the desktop app: the user's and project's settings and CLAUDE.md files are read; managed
  // settings always apply on top and lock permissions, hooks and MCP servers.
  settingSources: ["user", "project", "local"],
  includePartialMessages: true,
  enableFileCheckpointing: true,
  env: { ...process.env },
  stderr: (data) => process.stderr.write(data),
});

// ── connection to the gateway ──────────────────────────────────────────────────────────────

const clients = new Set();
const waiting = new Map(); // host → client request id → { resolve }
let nextId = 1;

const notify = (method, params) => {
  const line = JSON.stringify({ jsonrpc: "2.0", method, params });
  for (const ws of clients) ws.send(line);
};

/** Ask the client something and wait for its answer (or for the signal to abort). */
function ask(method, params, signal) {
  const id = `host-${nextId++}`;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    for (const ws of clients) ws.send(line);
    signal?.addEventListener("abort", () => {
      if (!waiting.delete(id)) return;
      notify("session/permissionCancelled", { id });
      reject(new Error("aborted"));
    });
  });
}

// ── sessions ───────────────────────────────────────────────────────────────────────────────

/** Live sessions: an SDK query fed by an input queue. Idle ones stay open until closed. */
const live = new Map();

function openSession(sessionId, settings, { resume = false, resumeAt } = {}) {
  const inbox = [];
  let wake = () => {};
  let closed = false;
  async function* input() {
    while (!closed) {
      while (inbox.length) yield inbox.shift();
      await new Promise((resolve) => (wake = resolve));
    }
  }
  const session = { id: sessionId, settings: { ...settings }, state: "idle", startedAt: Date.now() };
  const q = query({
    prompt: input(),
    options: {
      ...base(),
      ...(resume ? { resume: sessionId, ...(resumeAt ? { resumeSessionAt: resumeAt } : {}) } : { sessionId }),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      canUseTool: (toolName, toolInput, opts) => decide(session, toolName, toolInput, opts),
    },
  });
  Object.assign(session, {
    q,
    push(message) {
      inbox.push(message);
      wake();
    },
    close() {
      closed = true;
      wake();
      q.close();
    },
  });
  const setState = (state) => {
    if (session.state === state) return;
    session.state = state;
    notify("session/state", { sessionId, state });
  };
  session.setState = setState;
  (async () => {
    try {
      for await (const message of q) {
        notify("session/message", { sessionId, message });
        if (message.type === "result") setState("idle");
        else if (message.type !== "system" || message.subtype === "status") setState("running");
      }
    } catch (error) {
      notify("session/message", { sessionId, message: { type: "host_error", error: String(error?.message ?? error) } });
    } finally {
      live.delete(sessionId);
      setState("idle");
    }
  })();
  live.set(sessionId, session);
  return session;
}

/** The plan this session wrote last (the approval card shows it). */
function latestPlan(since) {
  try {
    const newest = fs
      .readdirSync(PLANS)
      .filter((name) => name.endsWith(".md"))
      .map((name) => ({ file: path.join(PLANS, name), mtime: fs.statSync(path.join(PLANS, name)).mtimeMs }))
      .filter((f) => f.mtime >= since)
      .sort((a, b) => b.mtime - a.mtime)[0];
    return newest ? { plan: fs.readFileSync(newest.file, "utf8").slice(0, MAX_PLAN), planFile: newest.file } : {};
  } catch {
    return {};
  }
}

/** The engine asks before using a tool: the candidate answers through the gateway. */
async function decide(session, toolName, input, opts) {
  try {
    const answer = await ask(
      "session/permission",
      {
        sessionId: session.id,
        toolName,
        input,
        title: opts.title,
        displayName: opts.displayName,
        description: opts.description,
        decisionReason: opts.decisionReason,
        blockedPath: opts.blockedPath,
        toolUseID: opts.toolUseID,
        agentID: opts.agentID,
        suggestions: opts.suggestions,
        ...(toolName === "ExitPlanMode" ? latestPlan(session.startedAt) : {}),
      },
      opts.signal,
    );
    if (answer?.behavior === "allow") {
      // Questions come back with the candidate's answers; any other tool runs as the engine asked.
      const updatedInput = toolName === "AskUserQuestion" && answer.answers ? { ...input, answers: answer.answers } : input;
      const rules = answer.alwaysAllow ? [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName, ...(answer.ruleContent ? { ruleContent: answer.ruleContent } : {}) }] }] : undefined;
      return { behavior: "allow", updatedInput, ...(rules ? { updatedPermissions: rules } : {}) };
    }
    return { behavior: "deny", message: typeof answer?.message === "string" && answer.message ? answer.message : "The user denied this.", interrupt: !!answer?.interrupt };
  } catch {
    return { behavior: "deny", message: "The request was cancelled." };
  }
}

const userMessage = (sessionId, text) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId });

function pick(params = {}) {
  const settings = {};
  if (params.model !== undefined) settings.model = String(params.model);
  if (params.permissionMode !== undefined) {
    if (!MODES.has(params.permissionMode)) throw rpcError(-32602, "Unsupported permission mode");
    settings.permissionMode = params.permissionMode;
  }
  if (params.effort !== undefined) {
    if (!EFFORTS.has(params.effort)) throw rpcError(-32602, "Unsupported effort");
    settings.effort = params.effort;
  }
  return settings;
}

const rpcError = (code, message) => Object.assign(new Error(message), { rpc: { code, message } });

let info;
/** What the engine offers (commands, models, agents, output styles), asked once. */
async function engineInfo() {
  if (info) return info;
  let release = () => {};
  const idle = (async function* () {
    await new Promise((resolve) => (release = resolve));
  })();
  const q = query({ prompt: idle, options: base() });
  try {
    const init = await q.initializationResult();
    info = {
      models: init.models,
      commands: init.commands,
      agents: init.agents,
      outputStyle: init.output_style,
      outputStyles: init.available_output_styles,
    };
    return info;
  } finally {
    release();
    q.close();
  }
}

const handlers = {
  async initialize() {
    return { workspace: WORKSPACE, modes: [...MODES], efforts: [...EFFORTS], ...(await engineInfo()) };
  },
  async "session/list"() {
    const sessions = await listSessions({ dir: WORKSPACE });
    return { sessions: sessions.map((s) => ({ ...s, archived: s.tag === ARCHIVED, state: live.get(s.sessionId)?.state ?? "idle" })) };
  },
  async "session/read"({ sessionId }) {
    return { messages: await getSessionMessages(sessionId, { dir: WORKSPACE }), info: await getSessionInfo(sessionId, { dir: WORKSPACE }) };
  },
  /** Send a prompt; without a sessionId this starts a session (its id comes back at once). */
  async "session/send"({ sessionId, text, ...rest }) {
    if (typeof text !== "string" || !text.trim()) throw rpcError(-32602, "Nothing to send");
    const settings = pick(rest);
    let session = sessionId ? live.get(sessionId) : undefined;
    if (!session) {
      const id = sessionId ?? crypto.randomUUID();
      session = openSession(id, settings, { resume: !!sessionId });
    } else if (Object.keys(settings).length) {
      await configure(session, settings);
    }
    session.setState("running");
    session.push(userMessage(session.id, text));
    return { sessionId: session.id };
  },
  async "session/interrupt"({ sessionId }) {
    await live.get(sessionId)?.q.interrupt();
    return {};
  },
  async "session/configure"({ sessionId, ...rest }) {
    const session = live.get(sessionId);
    if (session) await configure(session, pick(rest));
    return {};
  },
  async "session/rename"({ sessionId, title }) {
    await renameSession(sessionId, String(title), { dir: WORKSPACE });
    return {};
  },
  async "session/fork"({ sessionId, upToMessageId, title }) {
    const result = await forkSession(sessionId, { dir: WORKSPACE, ...(upToMessageId ? { upToMessageId } : {}), ...(title ? { title } : {}) });
    return result;
  },
  async "session/archive"({ sessionId, archived = true }) {
    await tagSession(sessionId, archived ? ARCHIVED : null, { dir: WORKSPACE });
    return {};
  },
  async "session/rewindFiles"({ sessionId, userMessageId, dryRun = false }) {
    const session = live.get(sessionId) ?? openSession(sessionId, {}, { resume: true });
    return await session.q.rewindFiles(userMessageId, { dryRun });
  },
  async "session/context"({ sessionId }) {
    const session = live.get(sessionId);
    return session ? await session.q.getContextUsage() : null;
  },
  async "session/close"({ sessionId }) {
    live.get(sessionId)?.close();
    return {};
  },
};

/** Model and mode change on the running engine; effort applies from the next session start. */
async function configure(session, settings) {
  if (settings.model && settings.model !== session.settings.model) await session.q.setModel(settings.model);
  if (settings.permissionMode && settings.permissionMode !== session.settings.permissionMode) await session.q.setPermissionMode(settings.permissionMode);
  if (settings.effort && settings.effort !== session.settings.effort && session.state === "idle") {
    session.close();
    openSession(session.id, { ...session.settings, ...settings }, { resume: true });
    return;
  }
  Object.assign(session.settings, settings);
}

// ── server ─────────────────────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: ({ req }) => {
    const given = new URL(req.url ?? "/", "http://host").searchParams.get("token") ?? "";
    return given.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
  },
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    // An answer to something the host asked.
    if (msg.id !== undefined && !msg.method) {
      const pending = waiting.get(String(msg.id));
      if (!pending) return;
      waiting.delete(String(msg.id));
      return msg.error ? pending.reject(msg.error) : pending.resolve(msg.result);
    }
    const handler = Object.hasOwn(handlers, msg.method) ? handlers[msg.method] : undefined;
    if (msg.id === undefined) return; // notifications from the client: none are expected
    if (!handler) return ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
    try {
      const result = await handler(msg.params ?? {});
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }));
    } catch (error) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: error.rpc ?? { code: -32000, message: String(error?.message ?? error) } }));
    }
  });
});

wss.on("listening", () => console.log(`cosmo-code engine host on 127.0.0.1:${PORT}`));
