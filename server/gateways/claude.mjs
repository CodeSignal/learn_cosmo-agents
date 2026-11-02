// Cosmo Code's gateway to its engine host (engines/claude-host; JSON-RPC over a loopback
// WebSocket, see jsonrpc.mjs). Every host method is classified; each one's parameters are an
// allowlist, and settings are checked against the task: models from the allowlist, permission
// modes the task allows (never bypass). Answers to the engine's permission requests are plain:
// allow or deny, an "always allow" only for the rule the engine suggested, and edited input only
// for questions (the candidate's answers).
import { createTurnRecorder } from "../turns.mjs";
import { createJsonRpcGateway, observers } from "./jsonrpc.mjs";
import { createTranscript, resultText } from "../transcript.mjs";

export const CLAUDE_HOST_PROTOCOL = 1;

const HISTORY = "the session history";

/** Host methods and what the gateway does with them, and the parameters each may carry. */
export const METHODS = {
  initialize: "allow",
  "session/list": "allow",
  "session/read": "allow",
  "session/send": "allow",
  "session/interrupt": "allow",
  "session/configure": "allow",
  "session/rename": "allow",
  "session/fork": "allow",
  "session/archive": "allow",
  "session/rewindFiles": "allow",
  "session/rewind": "allow",
  "session/undoRewind": "allow",
  "session/context": "allow",
  "session/close": "allow",
  "session/subagent": "allow",
  "files/search": "allow",
  "files/tree": "allow",
  "files/read": "allow",
  // The candidate's own shell: only when the task has a terminal.
  "terminal/open": "terminal",
  "terminal/write": "terminal",
  "terminal/resize": "terminal",
  "terminal/close": "terminal",
  // Transcripts are the task's record: the candidate can archive a session, not delete it.
  "session/delete": HISTORY,
};

const PARAMS = {
  initialize: [],
  "session/list": [],
  "session/read": ["sessionId"],
  "session/send": ["sessionId", "text", "model", "permissionMode", "effort", "instructions"],
  "session/interrupt": ["sessionId"],
  "session/configure": ["sessionId", "model", "permissionMode", "effort"],
  "session/rename": ["sessionId", "title"],
  "session/fork": ["sessionId", "upToMessageId", "title"],
  "session/archive": ["sessionId", "archived"],
  "session/rewindFiles": ["sessionId", "userMessageId", "dryRun"],
  "session/context": ["sessionId"],
  "session/close": ["sessionId"],
  "session/rewind": ["sessionId", "userMessageId"],
  "session/undoRewind": ["sessionId"],
  "session/subagent": ["sessionId", "agentId"],
  "files/search": ["query", "limit"],
  "files/tree": [],
  "files/read": ["path"],
  "terminal/open": ["cols", "rows"],
  "terminal/write": ["id", "data"],
  "terminal/resize": ["id", "cols", "rows"],
  "terminal/close": ["id"],
};
const REQUIRED = {
  sessionId: ["session/read", "session/interrupt", "session/configure", "session/rename", "session/fork", "session/archive", "session/rewindFiles", "session/rewind", "session/undoRewind", "session/context", "session/close", "session/subagent"],
  id: ["terminal/write", "terminal/resize", "terminal/close"],
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A subagent's id (the engine's own, e.g. "af6f0ecd0c89ad2e5"); it names its transcript file.
const AGENT_ID = /^[a-z0-9]{8,40}$/;
const MAX_TEXT = 200_000;
const MAX_INSTRUCTIONS = 4000;

/** A path inside the workspace, given relative to it (no "..", not absolute). */
const relativePath = (p) => typeof p === "string" && p.length > 0 && p.length <= 1024 && !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\0");

/**
 * @param ctx  { models: model ids and aliases the task allows, modes: permission modes allowed }
 */
export function checkParams(method, params = {}, ctx) {
  const p = params && typeof params === "object" && !Array.isArray(params) ? { ...params } : {};
  const allowed = new Set(PARAMS[method] ?? []);
  const unknown = Object.keys(p).find((k) => !allowed.has(k) && p[k] !== undefined);
  if (unknown) return { reason: `the "${unknown.slice(0, 40)}" option` };
  if (REQUIRED.sessionId.includes(method) && !ID.test(String(p.sessionId ?? ""))) return { reason: "this session" };
  if (p.sessionId !== undefined && !ID.test(String(p.sessionId))) return { reason: "this session" };
  if (p.upToMessageId !== undefined && !ID.test(String(p.upToMessageId))) return { reason: "this message" };
  if (p.userMessageId !== undefined && !ID.test(String(p.userMessageId))) return { reason: "this message" };
  if ((method === "session/rewindFiles" || method === "session/rewind") && p.userMessageId === undefined) return { reason: "this message" };
  if (REQUIRED.id.includes(method) && !ID.test(String(p.id ?? ""))) return { reason: "this terminal" };
  if (method === "session/subagent" && !AGENT_ID.test(String(p.agentId ?? ""))) return { reason: "this subagent" };
  if (method === "files/read" && !relativePath(p.path)) return { reason: "files outside the task's workspace" };
  if (p.data !== undefined && (typeof p.data !== "string" || p.data.length > 64 * 1024 || !/^[A-Za-z0-9+/=]*$/.test(p.data))) return { reason: "this input" };
  for (const size of ["cols", "rows"]) if (p[size] !== undefined && !(Number.isInteger(p[size]) && p[size] >= 2 && p[size] <= 1000)) return { reason: "the terminal size" };
  if (p.model !== undefined && !ctx.models.includes(p.model)) return { reason: `the model (${String(p.model).slice(0, 40)} isn't available in this task)` };
  if (p.permissionMode !== undefined && !ctx.modes.includes(p.permissionMode)) return { reason: "the permission mode" };
  if (p.effort !== undefined && !EFFORTS.includes(p.effort)) return { reason: "the effort" };
  if (method === "session/send" && (typeof p.text !== "string" || !p.text.trim() || p.text.length > MAX_TEXT)) return { reason: "this message" };
  if (method === "session/send" && p.instructions !== undefined && (typeof p.instructions !== "string" || p.instructions.length > MAX_INSTRUCTIONS)) return { reason: "these instructions" };
  if (p.title !== undefined && (typeof p.title !== "string" || p.title.length > 200)) return { reason: "the title" };
  for (const flag of ["archived", "dryRun"]) if (p[flag] !== undefined && typeof p[flag] !== "boolean") return { reason: `the "${flag}" option` };
  if (p.query !== undefined && (typeof p.query !== "string" || p.query.length > 200)) return { reason: "the search" };
  if (p.limit !== undefined && !(Number.isInteger(p.limit) && p.limit > 0 && p.limit <= 100)) return { reason: "the search" };
  return { params: p };
}

/**
 * The candidate's answer to a permission request, reduced to what the engine host accepts.
 * Returns { result, reply } or { reason }.
 */
export function checkAnswer(asked, result = {}, ctx = {}) {
  const { toolName, suggestions = [] } = asked.params ?? {};
  if (result.behavior !== "allow" && result.behavior !== "deny") return { reason: "this answer" };
  // The managed settings already keep the sandbox off the network; this is the backstop.
  if (toolName === "SandboxNetworkAccess" && result.behavior === "allow" && !ctx.webTools) return { reason: "network access" };
  if (result.behavior === "deny") {
    const message = typeof result.message === "string" ? result.message.slice(0, 4000) : undefined;
    return { result: { behavior: "deny", ...(message ? { message } : {}), interrupt: result.interrupt === true }, reply: "deny" };
  }
  const out = { behavior: "allow" };
  if (result.answers !== undefined) {
    if (toolName !== "AskUserQuestion") return { reason: "the tool's input" };
    const entries = result.answers && typeof result.answers === "object" ? Object.entries(result.answers) : [];
    if (!entries.length || entries.length > 20 || entries.some(([k, v]) => typeof v !== "string" || k.length > 2000 || v.length > 4000)) return { reason: "these answers" };
    out.answers = Object.fromEntries(entries);
  }
  if (result.alwaysAllow === true) {
    // Only the rule the engine itself suggested for this tool, and only for this session.
    const offered = suggestions.flatMap((s) => (s?.type === "addRules" && s.behavior === "allow" ? (s.rules ?? []) : [])).filter((r) => r.toolName === toolName);
    if (result.ruleContent !== undefined && !offered.some((r) => r.ruleContent === result.ruleContent)) return { reason: "this permission rule" };
    out.alwaysAllow = true;
    if (result.ruleContent !== undefined) out.ruleContent = result.ruleContent;
  }
  return { result: out, reply: out.alwaysAllow ? "always" : "once" };
}

/**
 * @param url       ws://127.0.0.1:<port>/?token=<per-boot token>
 * @param ceilings  { models, modes, webTools } from policy/render.mjs claudeCeilings
 */
// The app's own tools (the task list, the next-step box) aren't the agent's work.
const APP_TOOL = "mcp__cosmo_turn__";

/** The turn record from the engine host's traffic: prompts sent, the model and mode each session's
 * engine reports, the main agent's tool calls, and each turn's result. */
export function claudeTurns(turns) {
  return {
    call(method, params, result) {
      if (method === "session/send") turns.start(result?.sessionId ?? params?.sessionId, { prompt: params?.text, model: params?.model, mode: params?.permissionMode });
      else if (method === "session/configure") turns.settings(params?.sessionId, { model: params?.model, mode: params?.permissionMode });
    },
    notify(msg) {
      if (msg.method !== "session/message") return;
      const { sessionId, message: m } = msg.params ?? {};
      if (m?.type === "system" && m.subtype === "init") turns.settings(sessionId, { model: m.model, mode: m.permissionMode });
      else if (m?.type === "assistant" && !m.parent_tool_use_id && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) if (b?.type === "tool_use" && !String(b.name).startsWith(APP_TOOL)) turns.tool(sessionId, b.name);
      } else if (m?.type === "result") turns.end(sessionId, m.subtype === "success" ? "completed" : m.subtype === "error_during_execution" ? "interrupted" : "failed");
    },
  };
}

const FILE_TOOLS = { Edit: "ai_edit", MultiEdit: "ai_edit", NotebookEdit: "ai_edit", Write: "ai_write" };

/** The transcript record (server/transcript.mjs) from the engine host's traffic. */
export function claudeTranscript(t) {
  return {
    call(method, params, result) {
      const id = result?.sessionId ?? params?.sessionId;
      if (method === "session/send") {
        t.model(id, params?.model);
        t.mode(id, params?.permissionMode);
        t.prompt(id, params?.text);
      } else if (method === "session/configure") {
        t.model(id, params?.model);
        t.mode(id, params?.permissionMode);
      }
    },
    notify(msg) {
      if (msg.method !== "session/message") return;
      const { sessionId: id, message: m } = msg.params ?? {};
      if (!m || m.parent_tool_use_id) return; // a subagent's own conversation
      if (m.type === "system" && m.subtype === "init") {
        t.model(id, m.model);
        t.mode(id, m.permissionMode);
      } else if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b?.type === "text") t.text(id, b.text);
          else if (b?.type === "tool_use" && !String(b.name).startsWith(APP_TOOL)) {
            const input = b.input ?? {};
            t.tool(id, { callId: b.id, name: b.name, command: b.name === "Bash" ? input.command : undefined, file: FILE_TOOLS[b.name] ? input.file_path ?? input.notebook_path : undefined, action: FILE_TOOLS[b.name] });
          }
        }
      } else if (m.type === "user" && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b?.type === "tool_result") t.result(id, { callId: b.tool_use_id, isError: !!b.is_error, errorText: resultText(b.content) });
        }
      } else if (m.type === "result") {
        t.tokens(id, m.usage && { input_tokens: m.usage.input_tokens, output_tokens: m.usage.output_tokens, cache_read_input_tokens: m.usage.cache_read_input_tokens, cache_creation_input_tokens: m.usage.cache_creation_input_tokens });
        t.end(id);
      }
    },
  };
}

/**
 * @param transcripts  where the transcript record goes (<workspace>/.codesignal), or none
 */
export function createClaudeGateway({ url, ceilings, terminal = false, events, agent = "cosmo-code", transcripts, workspace = "/usercode/FILESYSTEM" }) {
  const ctx = { models: [...ceilings.models], modes: [...ceilings.modes], webTools: !!ceilings.webTools };
  const handler = createJsonRpcGateway({
    name: "claude",
    agent,
    url,
    handshake: { method: "initialize", params: { protocol: CLAUDE_HOST_PROTOCOL } },
    methods: METHODS,
    terminal,
    events,
    check: async (method, params, link) => {
      // The engine names the allowed models by alias too ("default", "sonnet"); those resolve within
      // the managed allowlist, so they're as good as the ids.
      const aliases = (link.info?.models ?? []).map((m) => m.value).filter(Boolean);
      return checkParams(method, params, { ...ctx, models: [...ctx.models, ...aliases] });
    },
    ask: (msg) => (msg.method === "session/permission" ? true : "this request"),
    answer: (asked, result) => checkAnswer(asked, result, ctx),
    resolvedId: (msg) => (msg.method === "session/permissionCancelled" ? msg.params?.id : undefined),
    observe: observers(
      claudeTurns(createTurnRecorder({ events, gateway: "claude", agent })),
      claudeTranscript(createTranscript({ dir: transcripts && `${transcripts}/claude`, agent, project: workspace })),
    ),
  });
  return handler;
}
