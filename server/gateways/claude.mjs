// Cosmo Code's gateway to its engine host (engines/claude-host; JSON-RPC over a loopback
// WebSocket, see jsonrpc.mjs). Every host method is classified; each one's parameters are an
// allowlist, and settings are checked against the task: models from the allowlist, permission
// modes the task allows (never bypass). Answers to the engine's permission requests are plain:
// allow or deny, an "always allow" only for the rule the engine suggested, and edited input only
// for questions (the candidate's answers).
import { createJsonRpcGateway } from "./jsonrpc.mjs";

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
  "session/context": "allow",
  "session/close": "allow",
  "files/search": "allow",
  // Transcripts are the task's record: the candidate can archive a session, not delete it.
  "session/delete": HISTORY,
};

const PARAMS = {
  initialize: [],
  "session/list": [],
  "session/read": ["sessionId"],
  "session/send": ["sessionId", "text", "model", "permissionMode", "effort"],
  "session/interrupt": ["sessionId"],
  "session/configure": ["sessionId", "model", "permissionMode", "effort"],
  "session/rename": ["sessionId", "title"],
  "session/fork": ["sessionId", "upToMessageId", "title"],
  "session/archive": ["sessionId", "archived"],
  "session/rewindFiles": ["sessionId", "userMessageId", "dryRun"],
  "session/context": ["sessionId"],
  "session/close": ["sessionId"],
  "files/search": ["query", "limit"],
};
const REQUIRED = { sessionId: ["session/read", "session/interrupt", "session/configure", "session/rename", "session/fork", "session/archive", "session/rewindFiles", "session/context", "session/close"] };

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 200_000;

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
  if (method === "session/rewindFiles" && p.userMessageId === undefined) return { reason: "this message" };
  if (p.model !== undefined && !ctx.models.includes(p.model)) return { reason: `the model (${String(p.model).slice(0, 40)} isn't available in this task)` };
  if (p.permissionMode !== undefined && !ctx.modes.includes(p.permissionMode)) return { reason: "the permission mode" };
  if (p.effort !== undefined && !EFFORTS.includes(p.effort)) return { reason: "the effort" };
  if (method === "session/send" && (typeof p.text !== "string" || !p.text.trim() || p.text.length > MAX_TEXT)) return { reason: "this message" };
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
export function createClaudeGateway({ url, ceilings, events, agent = "cosmo-code" }) {
  const ctx = { models: [...ceilings.models], modes: [...ceilings.modes], webTools: !!ceilings.webTools };
  const handler = createJsonRpcGateway({
    name: "claude",
    agent,
    url,
    handshake: { method: "initialize", params: { protocol: CLAUDE_HOST_PROTOCOL } },
    methods: METHODS,
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
  });
  return handler;
}
