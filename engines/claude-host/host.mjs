// The Cosmo Code engine host: the pinned Claude Code engine (driven through the Agent SDK) behind
// a small JSON-RPC protocol on a loopback WebSocket. The supervisor runs it as the session user,
// like the other engines; the server's gateway is its only client and decides what may pass.
// Everything about how the engine is set up is fixed here — binary, folder, setting sources — and
// the task's limits come from /etc/claude-code/managed-settings.json, which the engine enforces.
//
// Client → host:  initialize · session/list · session/read · session/send · session/interrupt ·
//                 session/configure · session/rename · session/fork · session/archive ·
//                 session/rewindFiles · session/rewind · session/undoRewind · session/context ·
//                 session/close · session/subagent · files/search · files/tree · files/read ·
//                 terminal/open · terminal/write · terminal/resize · terminal/close
// Host → client:  session/message {sessionId, message}   every SDK message, as it arrives
//                 session/state {sessionId, state}       "running" | "idle"
//                 session/permission (request)           the engine asks before using a tool
//                 session/permissionCancelled {id}       a pending ask the engine dropped
//                 terminal/output {id, data} · terminal/exit {id, code}
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { query, listSessions, getSessionMessages, getSubagentMessages, getSessionInfo, renameSession, forkSession, tagSession, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

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
const MANAGED = "/etc/claude-code/managed-settings.json";
// The candidate's terminal, only when the task has one ("sandboxed"; the gateway checks too).
const TERMINAL = process.env.COSMO_CODE_TERMINAL === "sandboxed";
const TERMINAL_SHELL = process.env.TERMINAL_SHELL ?? "/opt/agentsim/bin/terminal-shell";
const MAX_FILE = 1024 * 1024;

if (!TOKEN) {
  console.error("COSMO_CODE_TOKEN is required");
  process.exit(2);
}

// The app's own tools, as the desktop app gives them to the engine: the task list under the latest
// message and the next-step box at the end of a turn. They only report back; the UI draws them
// from the calls in the transcript, so the handlers just acknowledge.
const APP_TOOLS = "cosmo_turn";
const appTools = () =>
  createSdkMcpServer({
    name: APP_TOOLS,
    version: "1.0.0",
    tools: [
      tool(
        "update_plan",
        "Keep the task list the app shows under your latest message while you work. Send the whole plan: short imperative steps in order, exactly one in_progress while working. Call it again as each step finishes. It disappears when the turn ends.",
        {
          items: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })).min(1).max(12),
        },
        async () => ({ content: [{ type: "text", text: "Task list shown." }] }),
      ),
      tool(
        "wrap_up",
        "Fill the next-step box the app shows at the end of your turn: a two-or-three-sentence recap of what is now true, and, when the user has a decision to make, one short question with one or two buttons that answer it (the first is the recommendation). Call it once, when the turn's work is done, before your closing message.",
        {
          recap: z.string().max(600),
          ask: z.string().max(200).optional(),
          actions: z.array(z.object({ label: z.string().max(40), message: z.string().max(600).optional() })).max(2).optional(),
        },
        async () => ({ content: [{ type: "text", text: "Next-step box shown." }] }),
      ),
    ],
  });

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

/** Rewound sessions: where the conversation was cut, and where it ended before (for Undo). */
const rewinds = new Map();

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
      // Claude Code's own system prompt, as in the desktop app, with the candidate's instructions
      // (Settings → General) for a new session; a resumed session keeps the prompt it recorded.
      systemPrompt: { type: "preset", preset: "claude_code", ...(settings.instructions ? { append: settings.instructions } : {}) },
      ...(resume ? { resume: sessionId, ...(resumeAt ? { resumeSessionAt: resumeAt } : {}) } : { sessionId }),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      mcpServers: { [APP_TOOLS]: appTools() },
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
        // A turn runs from the prompt to its result; status and other system messages can come
        // after the result, so only the turn's own traffic counts as running.
        if (message.type === "result") setState("idle");
        else if (message.type === "assistant" || message.type === "stream_event") setState("running");
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
  // The app's own tools only draw something; they never need the candidate's go-ahead.
  if (toolName.startsWith(`mcp__${APP_TOOLS}__`)) return { behavior: "allow", updatedInput: input };
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
  if (typeof params.instructions === "string" && params.instructions.trim()) settings.instructions = params.instructions.slice(0, 4000);
  return settings;
}

const rpcError = (code, message) => Object.assign(new Error(message), { rpc: { code, message } });

/** The mode sessions start in, as the managed settings say (the prompt bar shows it up front). */
function managedDefaultMode() {
  try {
    const mode = JSON.parse(fs.readFileSync(MANAGED, "utf8")).permissions?.defaultMode;
    return MODES.has(mode) ? mode : "default";
  } catch {
    return "default";
  }
}

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

// ── files (for @ mentions) ───────────────────────────────────────────────────────────────────

const SKIP = new Set([".git", "node_modules", ".codesignal", ".venv", "__pycache__", ".next", "dist", "build"]);
let fileCache = { at: 0, files: [] };

/** The workspace's files (relative paths), cached for a few seconds. */
function workspaceFiles() {
  if (Date.now() - fileCache.at < 5000) return fileCache.files;
  const files = [];
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= 20_000) return;
      if (SKIP.has(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath);
      else if (e.isFile()) files.push(relPath);
    }
  };
  walk(WORKSPACE, "");
  fileCache = { at: Date.now(), files };
  return files;
}

/** Files whose path contains the query's letters in order; name matches and short paths first. */
function searchFiles(query, limit) {
  const q = query.toLowerCase();
  const scored = [];
  for (const file of workspaceFiles()) {
    const lower = file.toLowerCase();
    let at = -1;
    let ok = true;
    for (const ch of q) {
      at = lower.indexOf(ch, at + 1);
      if (at < 0) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    scored.push({ file, score: (name.includes(q) ? 0 : lower.includes(q) ? 1 : 2) * 1000 + file.length });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.file);
}

const handlers = {
  async initialize() {
    return { workspace: WORKSPACE, modes: [...MODES], efforts: [...EFFORTS], defaultMode: managedDefaultMode(), ...(await engineInfo()) };
  },
  async "session/list"() {
    const sessions = await listSessions({ dir: WORKSPACE });
    return { sessions: sessions.map((s) => ({ ...s, archived: s.tag === ARCHIVED, state: live.get(s.sessionId)?.state ?? "idle" })) };
  },
  async "session/read"({ sessionId }) {
    let messages = await getSessionMessages(sessionId, { dir: WORKSPACE });
    const rewound = rewinds.get(sessionId);
    if (rewound) messages = messages.slice(0, messages.findIndex((m) => m.uuid === rewound.at) + 1);
    return { messages, info: await getSessionInfo(sessionId, { dir: WORKSPACE }), ...(rewound ? { rewound: { userMessageId: rewound.userMessageId } } : {}) };
  },
  /** A subagent's conversation (its own transcript, beside the session's). */
  async "session/subagent"({ sessionId, agentId }) {
    if (!/^[a-z0-9]{8,40}$/.test(String(agentId))) throw rpcError(-32602, "No such subagent");
    return { messages: await getSubagentMessages(sessionId, agentId, { dir: WORKSPACE }) };
  },
  /** Rewind to before a message: its files go back, and it and everything after leave the conversation. */
  async "session/rewind"({ sessionId, userMessageId }) {
    const messages = await getSessionMessages(sessionId, { dir: WORKSPACE });
    const at = messages.findIndex((m) => m.uuid === userMessageId);
    if (at < 0 || messages[at].type !== "user") throw rpcError(-32602, "No such message in this session");
    if (!messages.slice(0, at).some(isPrompt)) throw rpcError(-32602, "The first message can't be rewound; start a new session instead.");
    const session = live.get(sessionId) ?? openSession(sessionId, {}, { resume: true });
    const files = await session.q.rewindFiles(userMessageId).catch((error) => ({ canRewind: false, error: String(error?.message ?? error) }));
    session.close();
    rewinds.set(sessionId, { at: messages[at - 1].uuid, leaf: messages.at(-1).uuid, userMessageId });
    return { files, text: promptText(messages[at].message) };
  },
  /** Bring back the messages a rewind removed (the files stay as they are). */
  async "session/undoRewind"({ sessionId }) {
    rewinds.delete(sessionId);
    live.get(sessionId)?.close();
    return {};
  },
  /** Send a prompt; without a sessionId this starts a session (its id comes back at once). */
  async "session/send"({ sessionId, text, ...rest }) {
    if (typeof text !== "string" || !text.trim()) throw rpcError(-32602, "Nothing to send");
    const settings = pick(rest);
    let session = sessionId ? live.get(sessionId) : undefined;
    if (!session) {
      const id = sessionId ?? crypto.randomUUID();
      // After a rewind the conversation continues from where it was cut.
      const resumeAt = rewinds.get(id)?.at;
      rewinds.delete(id);
      session = openSession(id, settings, { resume: !!sessionId, resumeAt });
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
  async "files/tree"() {
    return { files: workspaceFiles() };
  },
  /** A workspace file for the Files pane (read-only; symlinks out of the workspace are refused). */
  async "files/read"({ path: rel }) {
    const root = fs.realpathSync(WORKSPACE);
    let file;
    try {
      file = fs.realpathSync(path.resolve(WORKSPACE, String(rel)));
    } catch {
      throw rpcError(-32602, "No such file");
    }
    if (!file.startsWith(root + path.sep)) throw rpcError(-32001, "Only files in the workspace can be opened");
    const st = fs.statSync(file);
    if (!st.isFile()) throw rpcError(-32602, "Not a file");
    if (st.size > MAX_FILE) return { path: rel, size: st.size, tooLarge: true };
    const data = fs.readFileSync(file);
    if (data.subarray(0, 8000).includes(0)) return { path: rel, size: st.size, binary: true };
    return { path: rel, size: st.size, content: data.toString("utf8") };
  },
  async "terminal/open"({ cols = 80, rows = 24 }) {
    if (!TERMINAL) throw rpcError(-32001, "The terminal isn't available in this task.");
    return openTerminal(Number(cols) || 80, Number(rows) || 24);
  },
  async "terminal/write"({ id, data }) {
    terminals.get(id)?.stdin.write(Buffer.from(String(data), "base64"));
    return {};
  },
  async "terminal/resize"({ id, cols, rows }) {
    terminals.get(id)?.stdin.write(`\x1b]777;resize;${Number(cols) || 80};${Number(rows) || 24}\x07`);
    return {};
  },
  async "terminal/close"({ id }) {
    terminals.get(id)?.kill("SIGHUP");
    return {};
  },
  async "files/search"({ query = "", limit = 20 }) {
    return { files: searchFiles(String(query), Math.min(Number(limit) || 20, 100)) };
  },
  async "session/close"({ sessionId }) {
    live.get(sessionId)?.close();
    return {};
  },
};

/** The text of a prompt (reminders the engine adds aren't the candidate's). */
/** A prompt the candidate sent (not a tool result, and not text the engine added around one). */
function isPrompt(m) {
  if (m.type !== "user") return false;
  const content = m.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) return false;
  return !/^\s*<(system-reminder|local-command|command-name|command-message|command-args)/.test(promptText(m.message)) && !!promptText(m.message).trim();
}

function promptText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === "text" && !/^\s*<system-reminder>/.test(b.text ?? ""))
    .map((b) => b.text)
    .join("\n");
}

// ── terminal ────────────────────────────────────────────────────────────────────────────────

const terminals = new Map();

/**
 * A login shell in the workspace, in a sandbox fixed here: the whole system read-only except the
 * workspace and /tmp, no network, its own process tree; and no proxy keys in its environment.
 * terminal-shell gives bash a terminal of its own (job control) and takes resizes in-band.
 */
function openTerminal(cols, rows) {
  const id = crypto.randomUUID();
  const sandbox = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", WORKSPACE, WORKSPACE, "--bind", "/tmp", "/tmp", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session", "--chdir", WORKSPACE, "--", TERMINAL_SHELL];
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: os.homedir(), USER: os.userInfo().username, LANG: "C.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: String(cols), LINES: String(rows) };
  const child = spawn("bwrap", sandbox, { cwd: WORKSPACE, env, stdio: ["pipe", "pipe", "pipe"] });
  terminals.set(id, child);
  const out = (data) => notify("terminal/output", { id, data: data.toString("base64") });
  child.stdout.on("data", out);
  child.stderr.on("data", out);
  child.on("error", (error) => out(Buffer.from(`\r\n${error.message}\r\n`)));
  child.on("close", (code) => {
    terminals.delete(id);
    notify("terminal/exit", { id, code });
  });
  return { id };
}

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
