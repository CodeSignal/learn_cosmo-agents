// Cosmodex's gateway to `codex app-server` (JSON-RPC over a loopback WebSocket; see jsonrpc.mjs).
// Only classified methods pass, and their parameters are checked against what the task allows.
import path from "node:path";
import { createJsonRpcGateway, observers } from "./jsonrpc.mjs";
import { createTranscript } from "../transcript.mjs";
import { createTurnRecorder, inputText } from "../turns.mjs";
import { METHODS, DECISIONS, USER_INPUT, CODEX_VERSION } from "./codex-methods.mjs";
import STABLE_PARAMS from "./codex-params.json" with { type: "json" };

// The parameters each method's stable schema declares (scripts/gen-codex-params.mjs), plus the
// experimental ones Cosmodex needs. Anything else is refused: the experimental API also carries
// permission profiles, extra writable roots, injected history and context, which a task controls.
const EXPERIMENTAL_PARAMS = {
  "turn/start": ["collaborationMode"],
  "thread/fork": ["beforeTurnId", "deferGoalContinuation"],
  "thread/resume": ["initialTurnsPage"],
  "thread/list": ["parentThreadId", "ancestorThreadId"],
};

const SANDBOX_TYPES = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
// Parameters a candidate's UI never needs and that would change how the engine is set up.
const SETUP_KEYS = ["modelProvider", "config", "baseInstructions", "developerInstructions", "serviceTier", "serviceTierForTurn", "serviceName"];
const THREAD_SETUP = new Set(["thread/start", "thread/resume", "thread/fork"]);
// The terminal (command/exec) may set only what a terminal needs; the rest of its environment is the engine's.
const TERMINAL_ENV = new Set(["TERM", "COLORTERM", "COLUMNS", "LINES", "LANG", "LC_ALL"]);

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

  const known = new Set([...(STABLE_PARAMS[method] ?? []), ...(EXPERIMENTAL_PARAMS[method] ?? [])]);
  const unknown = Object.keys(p).find((k) => !known.has(k) && p[k] !== undefined);
  if (unknown) return { reason: `the "${unknown.slice(0, 40)}" option` };

  if (THREAD_SETUP.has(method) || method === "turn/start" || method === "command/exec") {
    for (const key of SETUP_KEYS) if (has(key)) return { reason: CONFIG_REASON(key) };
    if (has("approvalsReviewer") && !(ctx.reviewers ?? ["user"]).includes(p.approvalsReviewer)) return { reason: "the approval reviewer" };
    if (has("model") && !ctx.models.includes(p.model)) return { reason: `the model (${String(p.model).slice(0, 40)} isn't available in this task)` };
    const efforts = ctx.efforts?.length ? ctx.efforts : null;
    if (efforts && has("effort") && !efforts.includes(p.effort)) return { reason: "the reasoning effort" };
    if (efforts && p.collaborationMode?.settings?.reasoning_effort != null && !efforts.includes(p.collaborationMode.settings.reasoning_effort)) {
      return { reason: "the reasoning effort" };
    }
    // "Approve for me" works under on-request; the candidate answering keeps the task's policy.
    if (has("approvalsReviewer") && !has("approvalPolicy")) {
      p.approvalPolicy = p.approvalsReviewer === "auto_review" ? ctx.reviewerPolicy : ctx.approvalPolicies[0];
    }
    const reviewed = p.approvalsReviewer === "auto_review" && p.approvalPolicy === ctx.reviewerPolicy;
    if (has("approvalPolicy") && !reviewed && !(typeof p.approvalPolicy === "string" && ctx.approvalPolicies.includes(p.approvalPolicy))) {
      return { reason: "the approval policy" };
    }
    if (has("sandbox") && !ctx.sandboxModes.includes(p.sandbox)) return { reason: "the sandbox" };
    if (has("sandboxPolicy")) {
      const sp = p.sandboxPolicy;
      const mode = SANDBOX_TYPES[sp?.type];
      if (!mode || !ctx.sandboxModes.includes(mode)) return { reason: "the sandbox" };
      if (sp.networkAccess && !ctx.network) return { reason: "network access" };
      if ((sp.writableRoots ?? []).some((r) => !inside(r))) return { reason: "folders outside the task's workspace" };
    }
    if (has("cwd") && !inside(p.cwd)) return { reason: "folders outside the task's workspace" };
    if (has("collaborationMode")) {
      const cm = p.collaborationMode;
      if (!["plan", "default"].includes(cm?.mode)) return { reason: "the collaboration mode" };
      if (cm.settings?.developer_instructions != null) return { reason: "configuration" };
      if (cm.settings?.model != null && !ctx.models.includes(cm.settings.model)) {
        return { reason: `the model (${String(cm.settings.model).slice(0, 40)} isn't available in this task)` };
      }
    }
    if ((THREAD_SETUP.has(method) || method === "command/exec") && !has("cwd")) p.cwd = ctx.workspace;
    // The task's policy unless the UI picks an allowed one. Codex takes "untrusted" only from
    // its requirements file or a request, and without root there is no requirements file.
    if (THREAD_SETUP.has(method) && !has("approvalPolicy")) p.approvalPolicy = ctx.approvalPolicies[0];
  }
  if (method === "command/exec" && has("env")) {
    const key = typeof p.env === "object" ? Object.keys(p.env).find((k) => !TERMINAL_ENV.has(k)) : "env";
    if (key) return { reason: "the terminal's environment" };
  }
  if (method === "turn/start" || method === "turn/steer") {
    for (const item of Array.isArray(p.input) ? p.input : []) {
      if ((item?.type === "localImage" || item?.type === "localAudio" || item?.type === "mention") && !inside(item.path)) {
        return { reason: "files outside the task's workspace" };
      }
      // A skill's file is read into the prompt, so only skills the engine itself lists may be used.
      if (item?.type === "skill" && !ctx.skillPaths?.has(item.path)) return { reason: "skills" };
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

// Thread items that are the conversation itself rather than the agent's tool use.
const NOT_TOOLS = new Set(["userMessage", "agentMessage", "reasoning", "plan", "hookPrompt", "contextCompaction", "functionCallOutput"]);

/** The turn record from app-server traffic: threads' models, prompts (turn/start, turn/steer),
 * finished tool items, and turn/completed. */
export function codexTurns(turns) {
  return {
    call(method, params, result) {
      if (THREAD_SETUP.has(method)) turns.settings(result?.thread?.id, { model: result?.model });
      else if (method === "turn/start" || method === "turn/steer") {
        turns.start(params?.threadId, {
          prompt: inputText(params?.input),
          model: params?.model ?? params?.collaborationMode?.settings?.model,
          mode: params?.collaborationMode?.mode,
          steer: method === "turn/steer",
        });
      }
    },
    notify(msg) {
      const p = msg.params ?? {};
      if (msg.method === "item/completed" && p.item && !NOT_TOOLS.has(p.item.type)) {
        turns.tool(p.threadId, p.item.type === "mcpToolCall" ? `mcp:${p.item.server}/${p.item.tool}` : p.item.type);
      } else if (msg.method === "turn/completed") turns.end(p.threadId, p.turn?.status);
    },
  };
}

const FILE_ACTION = { add: "ai_write", delete: "ai_delete", update: "ai_edit" };

/** The transcript record (server/transcript.mjs) from app-server traffic. Codex reports approval
 * policies as its modes, as the provisioner does. */
export function codexTranscript(t) {
  return {
    call(method, params, result) {
      if (THREAD_SETUP.has(method)) {
        const id = result?.thread?.id;
        t.model(id, result?.model);
        t.mode(id, result?.approvalPolicy);
      } else if (method === "turn/start" || method === "turn/steer") {
        t.model(params?.threadId, params?.model);
        t.mode(params?.threadId, params?.approvalPolicy);
        t.prompt(params?.threadId, inputText(params?.input));
      }
    },
    notify(msg) {
      const p = msg.params ?? {};
      const item = p.item;
      if (msg.method === "item/completed" && item) {
        const id = p.threadId;
        const failed = ["failed", "declined"].includes(item.status);
        if (item.type === "agentMessage") t.text(id, item.text);
        else if (item.type === "commandExecution") {
          t.tool(id, { callId: item.id, name: "commandExecution" });
          t.command(id, { command: item.command, output: item.aggregatedOutput ?? undefined, exitCode: item.exitCode ?? undefined });
          t.result(id, { callId: item.id, isError: failed || (item.exitCode ?? 0) !== 0, errorText: item.aggregatedOutput ?? item.status });
        } else if (item.type === "fileChange") {
          t.tool(id, { callId: item.id, name: "fileChange" });
          for (const c of item.changes ?? []) t.file(id, { path: c.path, action: FILE_ACTION[c.kind?.type] ?? "ai_edit" });
          t.result(id, { callId: item.id, isError: failed, errorText: item.status });
        } else if (!NOT_TOOLS.has(item.type)) {
          t.tool(id, { callId: item.id, name: item.type === "mcpToolCall" ? `mcp:${item.server}/${item.tool}` : item.type });
          if (failed) t.result(id, { callId: item.id, isError: true, errorText: item.status });
        }
      } else if (msg.method === "thread/tokenUsage/updated") {
        const u = p.tokenUsage?.last;
        if (u) t.tokens(p.threadId, { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cached_input_tokens: u.cachedInputTokens, reasoning_output_tokens: u.reasoningOutputTokens, total_tokens: u.totalTokens });
      } else if (msg.method === "turn/completed") t.end(p.threadId);
    },
  };
}

/**
 * @param transcripts  where the transcript record goes (<workspace>/.codesignal), or none
 */
export function createCodexGateway({ url, workspace, terminal, ceilings, events, agent = "cosmodex", transcripts }) {
  const ctx = { workspace: workspace.replace(/\/+$/, ""), ...ceilings };

  async function refreshSkills(link) {
    try {
      const res = await link.request("skills/list", { cwds: [ctx.workspace] });
      ctx.skillPaths = new Set((res?.data ?? []).flatMap((entry) => (entry.skills ?? []).filter((k) => k.enabled).map((k) => k.path)));
    } catch {
      ctx.skillPaths = new Set();
    }
  }

  return createJsonRpcGateway({
    name: "codex",
    agent,
    url,
    // The experimental API carries plan mode and questions; experimental methods the gateway
    // hasn't classified stay refused.
    handshake: {
      method: "initialize",
      params: { clientInfo: { name: "cosmodex", title: "Cosmodex", version: CODEX_VERSION }, capabilities: { experimentalApi: true } },
      notify: "initialized",
    },
    methods: METHODS,
    terminal,
    events,
    check: async (method, params, link) => {
      if ((method === "turn/start" || method === "turn/steer") && Array.isArray(params?.input) && params.input.some((i) => i?.type === "skill")) {
        await refreshSkills(link);
      }
      return checkParams(method, params, ctx);
    },
    ask: (msg) => {
      if (DECISIONS[msg.method] || USER_INPUT.has(msg.method)) return true;
      if (msg.method === "item/permissions/requestApproval") return "extra permissions";
      return msg.method.startsWith("account/") ? "signing in" : "this request";
    },
    // Only the decision itself goes to the engine; free-form answers (questions) pass as given.
    answer: (asked, result) => {
      if (!DECISIONS[asked.method]) return { result };
      if (!DECISIONS[asked.method].includes(result.decision)) return { reason: "this approval option" };
      return { result: { decision: result.decision }, reply: result.decision };
    },
    resolvedId: (msg) => (msg.method === "serverRequest/resolved" ? msg.params?.requestId : undefined),
    observe: observers(
      codexTurns(createTurnRecorder({ events, gateway: "codex", agent })),
      codexTranscript(createTranscript({ dir: transcripts && `${transcripts}/codex`, agent, project: workspace, modeKey: "approval" })),
    ),
  });
}
