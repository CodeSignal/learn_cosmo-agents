// App state, kept in step with the engine host (through the gateway): sessions, each one's
// messages (history from session/read, then the live SDK messages), the text streaming in, and the
// engine's open permission requests.
import { createStore, produce } from "solid-js/store"
import { call, EngineError, listen, respond, type EngineMessage } from "./engine"

export const WORKSPACE = import.meta.env.VITE_WORKSPACE ?? "/usercode/FILESYSTEM"
export const FOLDER = WORKSPACE.split("/").filter(Boolean).pop() ?? "workspace"

export type Mode = "default" | "acceptEdits" | "plan"
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
export type ModelInfo = { value: string; resolvedModel?: string; displayName: string; description?: string; supportedEffortLevels?: Effort[] }

/** A transcript message as the SDK gives it (history and live alike). */
export type RawMessage = { type: "user" | "assistant" | "system"; uuid?: string; message: any; parent_tool_use_id?: string | null; local?: true }

export type Session = {
  id: string
  title: string
  lastModified: number
  archived: boolean
  state: "idle" | "running"
  loaded: boolean
  messages: RawMessage[]
  /** The reply streaming in (partial messages), until the complete message arrives. */
  streaming: { text: string; thinking: string } | null
  mode: Mode
  model: string | null
  effort: Effort | null
  /** How the last turn ended: "interrupted" when stopped. */
  ended: "done" | "interrupted" | "error" | null
  context: { percentage: number; totalTokens: number; maxTokens: number } | null
}

export type Command = { name: string; description: string; argumentHint?: string }
type Info = { models: ModelInfo[]; commands: Command[]; modes: Mode[]; defaultMode: Mode }

const [state, setState] = createStore({
  engine: "connecting" as "connecting" | "ready" | "reconnecting",
  info: null as Info | null,
  sessions: {} as Record<string, Session>,
  activeId: null as string | null,
  /** Settings for the next new session (the prompt bar before a session exists). */
  draft: { mode: null as Mode | null, model: null as string | null, effort: null as Effort | null },
  /** The engine's open permission requests (tools, plans, questions), by request id. */
  requests: {} as Record<string, EngineMessage>,
  /** Prompts queued with Ctrl+Enter while Claude works, by session. */
  queued: {} as Record<string, string[]>,
  sidebar: true,
  rail: true,
  /** The plan shown in the Plan pane, if open. */
  plan: null as string | null,
  /** The command palette (Ctrl+K): closed, or showing recents or actions. */
  palette: null as "recents" | "actions" | null,
  /** Next-step boxes the candidate dismissed, by the tool call that filled them. */
  dismissed: {} as Record<string, true>,
  /** The session whose title is being renamed in the title bar (from /rename). */
  renamingTitle: false,
  toast: null as string | null,
})
export { state }

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function showToast(message: string) {
  setState("toast", message)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => setState("toast", null), 4000)
}

function report(error: unknown) {
  console.error(error)
  showToast(error instanceof EngineError || error instanceof Error ? error.message : "Something went wrong")
}

export const activeSession = () => (state.activeId ? state.sessions[state.activeId] : undefined)
export const sessionOrder = () =>
  Object.values(state.sessions)
    .filter((s) => !s.archived)
    .sort((a, b) => b.lastModified - a.lastModified)
export const requestFor = (sessionId: string) => Object.values(state.requests).find((r) => r.params?.sessionId === sessionId)

/** The mode, model and effort the prompt bar shows: the session's, or the draft's for a new one. */
export function currentSettings() {
  const s = activeSession()
  const info = state.info
  return {
    mode: (s ? s.mode : state.draft.mode) ?? info?.defaultMode ?? "default",
    model: (s ? s.model : state.draft.model) ?? info?.models[0]?.value ?? null,
    effort: (s ? s.effort : state.draft.effort) ?? "medium",
  }
}

const blankSession = (id: string, title: string): Session => ({
  id,
  title,
  lastModified: Date.now(),
  archived: false,
  state: "idle",
  loaded: false,
  messages: [],
  streaming: null,
  mode: state.info?.defaultMode ?? "default",
  model: null,
  effort: null,
  ended: null,
  context: null,
})

// ── engine events ──────────────────────────────────────────────────────────────────────────

function onMessage(msg: EngineMessage) {
  const p = msg.params ?? {}
  if (msg.id !== undefined) {
    setState("requests", String(msg.id), msg)
    return
  }
  switch (msg.method) {
    case "cosmo-code/engine":
      setState("engine", p.state === "ready" ? "ready" : p.state === "reconnecting" ? "reconnecting" : "connecting")
      if (p.state === "ready") {
        void loadInfo()
        void refreshSessions()
      }
      return
    case "session/state":
      if (!state.sessions[p.sessionId]) return
      setState("sessions", p.sessionId, "state", p.state)
      if (p.state === "idle") void afterTurn(p.sessionId)
      return
    case "session/permissionCancelled":
      return setState("requests", produce((r) => delete r[String(p.id)]))
    case "session/message":
      return onSdkMessage(p.sessionId, p.message)
  }
}

function onSdkMessage(sessionId: string, m: any) {
  if (!state.sessions[sessionId]) setState("sessions", sessionId, blankSession(sessionId, "New session"))
  switch (m.type) {
    case "system":
      if (m.subtype === "init") {
        setState("sessions", sessionId, { mode: m.permissionMode ?? state.sessions[sessionId]!.mode, model: state.sessions[sessionId]!.model ?? null })
      } else if (m.subtype === "informational" && m.level === "warning") {
        showToast(m.content)
      }
      return
    case "stream_event": {
      const event = m.event
      if (event?.type === "message_start") setState("sessions", sessionId, "streaming", { text: "", thinking: "" })
      else if (event?.type === "content_block_delta") {
        const delta = event.delta
        setState("sessions", sessionId, "streaming", (s) => ({
          text: (s?.text ?? "") + (delta?.type === "text_delta" ? delta.text : ""),
          thinking: (s?.thinking ?? "") + (delta?.type === "thinking_delta" ? delta.thinking : ""),
        }))
      }
      return
    }
    case "assistant":
    case "user":
      if (m.type === "user" && m.message && !m.isSynthetic && typeof m.message.content === "string") {
        // The engine echoes a prompt we already show (sent below); keep ours.
        const local = state.sessions[sessionId]!.messages.findLast((x) => x.local && x.message.content === m.message.content)
        if (local) return
      }
      setState(
        "sessions",
        sessionId,
        produce((s) => {
          if (m.uuid && s.messages.some((x) => x.uuid === m.uuid)) return
          s.messages.push(m)
          if (m.type === "assistant") s.streaming = null
          s.lastModified = Date.now()
        }),
      )
      return
    case "result":
      setState("sessions", sessionId, {
        ended: m.subtype === "success" ? "done" : m.subtype === "error_during_execution" ? "interrupted" : "error",
        streaming: null,
      })
      return
    case "host_error":
      report(new Error(m.error))
      return
  }
}

/** After a turn: the context ring, the session's title, and the next queued prompt. */
async function afterTurn(sessionId: string) {
  void refreshContext(sessionId)
  void refreshSessions()
  const next = state.queued[sessionId]?.[0]
  if (next !== undefined) {
    setState("queued", sessionId, (q) => q.slice(1))
    await send(next)
  }
}

export function start() {
  listen(onMessage)
}

// ── calls ──────────────────────────────────────────────────────────────────────────────────

async function loadInfo() {
  try {
    setState("info", await call<Info>("initialize", {}))
  } catch (error) {
    report(error)
  }
}

type SessionInfo = { sessionId: string; summary?: string; customTitle?: string; firstPrompt?: string; lastModified: number; archived?: boolean; state?: "idle" | "running" }

export async function refreshSessions() {
  try {
    const { sessions } = await call<{ sessions: SessionInfo[] }>("session/list", {})
    setState(
      "sessions",
      produce((all) => {
        for (const info of sessions) {
          const title = info.customTitle || info.summary || info.firstPrompt || "New session"
          const s = all[info.sessionId] ?? blankSession(info.sessionId, title)
          all[info.sessionId] = { ...s, title, lastModified: info.lastModified, archived: !!info.archived, state: info.state ?? s.state }
        }
      }),
    )
  } catch (error) {
    report(error)
  }
}

export async function openSession(id: string) {
  setState({ activeId: id, plan: null })
  const s = state.sessions[id]
  if (!s || s.loaded) return
  try {
    const { messages } = await call<{ messages: RawMessage[] }>("session/read", { sessionId: id })
    setState("sessions", id, { messages: messages.filter((m) => m.type !== "system"), loaded: true })
    void refreshContext(id)
  } catch (error) {
    report(error)
  }
}

export function newSession() {
  setState({ activeId: null, plan: null })
}

async function refreshContext(sessionId: string) {
  try {
    const usage = await call<Session["context"]>("session/context", { sessionId })
    if (usage) setState("sessions", sessionId, "context", { percentage: usage.percentage, totalTokens: usage.totalTokens, maxTokens: usage.maxTokens })
  } catch {
    /* the session isn't open in the engine */
  }
}

/** Send a prompt: a new session when none is open. While Claude works it goes in now; queue() waits. */
export async function send(text: string) {
  const s = activeSession()
  try {
    if (!s) {
      const draft = currentSettings()
      const { sessionId } = await call<{ sessionId: string }>("session/send", {
        text,
        ...(state.draft.model ? { model: state.draft.model } : {}),
        permissionMode: draft.mode,
        ...(state.draft.effort ? { effort: state.draft.effort } : {}),
      })
      setState("sessions", sessionId, {
        ...blankSession(sessionId, text.slice(0, 80)),
        loaded: true,
        state: "running",
        mode: draft.mode,
        model: state.draft.model,
        effort: state.draft.effort,
        messages: [{ type: "user", message: { role: "user", content: text }, local: true }],
      })
      setState({ activeId: sessionId, draft: { mode: null, model: null, effort: null } })
      return
    }
    setState(
      "sessions",
      s.id,
      produce((x) => {
        x.messages.push({ type: "user", message: { role: "user", content: text }, local: true })
        x.state = "running"
        x.ended = null
      }),
    )
    await call("session/send", { sessionId: s.id, text })
  } catch (error) {
    report(error)
  }
}

export function queue(text: string) {
  const s = activeSession()
  if (!s || s.state !== "running") return void send(text)
  setState("queued", s.id, (q) => [...(q ?? []), text])
}

export async function interrupt() {
  const s = activeSession()
  if (!s) return
  try {
    await call("session/interrupt", { sessionId: s.id })
  } catch (error) {
    report(error)
  }
}

/** Mode, model or effort from the prompt bar: the open session's, or the next new session's. */
export async function configure(change: { mode?: Mode; model?: string; effort?: Effort }) {
  const s = activeSession()
  if (!s) {
    setState("draft", (d) => ({ ...d, ...change }))
    return
  }
  try {
    await call("session/configure", {
      sessionId: s.id,
      ...(change.mode ? { permissionMode: change.mode } : {}),
      ...(change.model ? { model: change.model } : {}),
      ...(change.effort ? { effort: change.effort } : {}),
    })
    setState("sessions", s.id, (x) => ({ ...x, ...change }))
  } catch (error) {
    report(error)
  }
}

export async function answer(requestId: string, result: Record<string, unknown>) {
  try {
    await respond(requestId, result)
    setState("requests", produce((r) => delete r[requestId]))
  } catch (error) {
    report(error)
  }
}

export async function rename(sessionId: string, title: string) {
  const clean = title.trim()
  if (!clean) return
  try {
    await call("session/rename", { sessionId, title: clean })
    setState("sessions", sessionId, "title", clean)
  } catch (error) {
    report(error)
  }
}

export async function fork(sessionId: string, upToMessageId?: string) {
  try {
    const { sessionId: id } = await call<{ sessionId: string }>("session/fork", { sessionId, ...(upToMessageId ? { upToMessageId } : {}) })
    await refreshSessions()
    await openSession(id)
    showToast("Forked session")
  } catch (error) {
    report(error)
  }
}

export async function archive(sessionId: string) {
  try {
    await call("session/archive", { sessionId, archived: true })
    setState("sessions", sessionId, "archived", true)
    if (state.activeId === sessionId) newSession()
  } catch (error) {
    report(error)
  }
}

export function toggleSidebar() {
  setState("sidebar", (v) => !v)
}

export function toggleRail() {
  setState("rail", (v) => !v)
}

export function showPlan(plan: string | null) {
  setState("plan", plan)
}

export async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast(`${what} copied`)
  } catch {
    showToast(`Couldn't copy the ${what.toLowerCase()}.`)
  }
}

export function openPalette(mode: "recents" | "actions" = "recents") {
  setState("palette", mode)
}

export function closePalette() {
  setState("palette", null)
}

export function dismiss(toolUseId: string) {
  setState("dismissed", toolUseId, true)
}

export function setRenamingTitle(on: boolean) {
  setState("renamingTitle", on)
}

/** Workspace files matching what follows an @ (the engine host searches the workspace). */
export async function searchFiles(query: string): Promise<string[]> {
  try {
    return (await call<{ files: string[] }>("files/search", { query, limit: 12 })).files
  } catch {
    return []
  }
}

/** Open one of the prompt bar's menus as its shortcut would (Ctrl+Shift+M, Ctrl+Shift+I, the ring). */
export function openMenu(menu: "mode" | "model" | "usage") {
  queueMicrotask(() => (document.querySelector(`[data-menu="${menu}"]`) as HTMLElement | null)?.click())
}
