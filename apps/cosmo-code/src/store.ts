// App state, kept in step with the engine host (through the gateway): sessions, each one's
// messages (history from session/read, then the live SDK messages), the text streaming in, and the
// engine's open permission requests.
import { createStore, produce } from "solid-js/store"
import { call, EngineError, listen, respond, type EngineMessage } from "./engine"
import { prefs } from "./prefs"
import { kindOf, statusOf, type BackgroundTask } from "./tasks"

export const WORKSPACE = import.meta.env.VITE_WORKSPACE ?? "/usercode/FILESYSTEM"
export type Pane = "plan" | "changes" | "terminal" | "files" | "tasks" | "preview"
export type SettingsPage = "general" | "privacy" | "usage" | "code" | "cowork" | "import" | "system" | "skills" | "connectors" | "plugins"
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
  /** After "Rewind to here": the message the conversation was cut before (Undo brings it back). */
  rewound: string | null
  /** Background tasks as the engine reported them live, by task id (history has the rest). */
  tasks: Record<string, Partial<BackgroundTask>>
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
  /** The plan shown in the Plan pane. */
  plan: null as string | null,
  /** The pane in the right column (else the session rail), and whether it fills the window. */
  pane: null as Pane | null,
  paneExpanded: false,
  /** The Background tasks pane's subagent (its Agent call), when one is open. */
  subagent: null as string | null,
  /** Finished tasks the candidate cleared from the Background tasks pane. */
  clearedTasks: {} as Record<string, true>,
  /** The Preview pane: workspace files shown (Back / Forward), and a counter Reload bumps. */
  preview: { history: [] as string[], at: -1, reload: 0 },
  /** Files open in the Files pane, and the one shown. */
  openFiles: [] as string[],
  openFile: null as string | null,
  /** Bumped after each turn and rewind: the Changes pane reloads. */
  changesVersion: 0,
  /** Text for the composer (a rewound message comes back to it). */
  composerText: null as string | null,
  /** Whether the task gives the candidate a terminal (the server's /api/session). */
  terminal: false,
  /** Where the server serves workspace files for the Preview pane (the server's /api/session). */
  previewBase: null as string | null,
  /** Whether the task runs commands in its sandbox (the server's /api/session). */
  sandbox: false,
  /** The Settings modal's page, when open; and the keyboard shortcuts dialog. */
  settings: null as SettingsPage | null,
  shortcuts: false,
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
  rewound: null,
  tasks: {},
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
    case "terminal/output":
      return toTerminal(p.id, { data: Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0)) })
    case "terminal/exit":
      return toTerminal(p.id, { exit: p.code })
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
      } else if (m.subtype === "task_started") {
        setState("sessions", sessionId, "tasks", m.task_id, {
          id: m.task_id,
          toolUseId: m.tool_use_id,
          kind: kindOf(m.task_type),
          description: m.description,
          subagentType: m.subagent_type,
          status: "running",
        })
      } else if (m.subtype === "task_updated" && state.sessions[sessionId]!.tasks[m.task_id]) {
        setState("sessions", sessionId, "tasks", m.task_id, {
          ...(m.patch?.status ? { status: statusOf(m.patch.status) } : {}),
          ...(m.patch?.description ? { description: m.patch.description } : {}),
        })
      } else if (m.subtype === "task_progress" && m.summary && state.sessions[sessionId]!.tasks[m.task_id]) {
        setState("sessions", sessionId, "tasks", m.task_id, "summary", m.summary)
      } else if (m.subtype === "task_notification") {
        setState("sessions", sessionId, "tasks", m.task_id, { id: m.task_id, toolUseId: m.tool_use_id, status: statusOf(m.status) })
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
          if (m.type === "user" && !m.parent_tool_use_id && sessionId === state.activeId) autoOpen(s.messages, m)
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

/** After a turn: the context ring, the session's title, changes, and the next queued prompt. */
async function afterTurn(sessionId: string) {
  setState("changesVersion", (v) => v + 1)
  void settleIds(sessionId)
  void refreshContext(sessionId)
  void refreshSessions()
  const next = state.queued[sessionId]?.[0]
  if (next !== undefined) {
    setState("queued", sessionId, (q) => q.slice(1))
    await send(next)
  }
}

const promptOf = (m: RawMessage) => {
  const content = m.message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content) || content.some((b: any) => b.type === "tool_result")) return null
  return content.map((b: any) => (b.type === "text" ? b.text : "")).join("")
}

/** Prompts sent here show at once, without the engine's ids; once the turn is over they take the ids
 * the engine stored them under (Rewind to here and Fork from here need them). */
async function settleIds(sessionId: string) {
  if (!state.sessions[sessionId]?.messages.some((m) => m.local)) return
  try {
    const { messages } = await call<{ messages: RawMessage[] }>("session/read", { sessionId })
    const stored = messages.filter((m) => m.type === "user" && m.uuid && promptOf(m) !== null)
    setState(
      "sessions",
      sessionId,
      "messages",
      produce((list) => {
        const taken = new Set(list.map((m) => m.uuid).filter(Boolean))
        for (const m of list) {
          if (!m.local) continue
          const text = promptOf(m) ?? ""
          const match = stored.find((x) => !taken.has(x.uuid) && promptOf(x)!.includes(text))
          if (!match) continue
          taken.add(match.uuid)
          m.uuid = match.uuid
          delete m.local
        }
      }),
    )
  } catch {
    /* they stay without ids until the session is opened again */
  }
}

export function start() {
  listen(onMessage)
  void fetch("/api/session")
    .then((res) => (res.ok ? res.json() : undefined))
    .then((session) => setState({ terminal: !!session?.terminal && session.terminal !== "off", sandbox: !!session?.sandbox, previewBase: session?.preview ?? null }))
    .catch(() => setState("terminal", false))
}

// Terminal output arrives as notifications; each terminal listens for its own.
// Output that arrives before its terminal listens (right after terminal/open) waits for it.
type TerminalEvent = { data?: Uint8Array; exit?: number | null }
const terminalSinks = new Map<string, (event: TerminalEvent) => void>()
const terminalEarly = new Map<string, TerminalEvent[]>()
export function onTerminal(id: string, sink: (event: TerminalEvent) => void) {
  terminalSinks.set(id, sink)
  for (const event of terminalEarly.get(id) ?? []) sink(event)
  terminalEarly.delete(id)
  return () => terminalSinks.delete(id)
}
function toTerminal(id: string, event: TerminalEvent) {
  const sink = terminalSinks.get(id)
  if (sink) return sink(event)
  if (!terminalEarly.has(id) && terminalEarly.size > 16) return
  terminalEarly.set(id, [...(terminalEarly.get(id) ?? []), event])
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
  setState({ activeId: id, plan: null, pane: state.pane === "plan" ? null : state.pane, subagent: state.activeId === id ? state.subagent : null })
  const s = state.sessions[id]
  if (!s || s.loaded) return
  try {
    const { messages, rewound } = await call<{ messages: RawMessage[]; rewound?: { userMessageId: string } }>("session/read", { sessionId: id })
    setState("sessions", id, { messages: messages.filter((m) => m.type !== "system"), loaded: true, rewound: rewound?.userMessageId ?? null })
    void refreshContext(id)
  } catch (error) {
    report(error)
  }
}

export function newSession() {
  setState({ activeId: null, plan: null, pane: state.pane === "plan" ? null : state.pane, subagent: null })
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
        // Settings → General → Instructions for Claude, for the sessions started from now on.
        ...(prefs.instructions.trim() ? { instructions: prefs.instructions.trim() } : {}),
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
        x.rewound = null
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

/** The rail shares the right column with the panes: it shows when no pane is open. */
export function toggleRail() {
  if (state.pane) setState({ pane: null, paneExpanded: false, rail: true })
  else setState("rail", (v) => !v)
}

export function showPlan(plan: string | null) {
  setState({ plan, pane: plan === null ? null : "plan" })
}

/** Open a pane in the right column, or close it if it's the one open. */
export function togglePane(pane: Pane) {
  setState({ pane: state.pane === pane ? null : pane, paneExpanded: false })
}

export function closePane() {
  setState({ pane: null, paneExpanded: false })
}

export function toggleExpanded() {
  setState("paneExpanded", (v) => !v)
}

/** Open a workspace file (relative path) in the Files pane. */
export function openSubagent(toolUseId: string) {
  setState({ pane: "tasks", subagent: toolUseId, paneExpanded: false })
}

export function closeSubagent() {
  setState("subagent", null)
}

export function clearTasks(ids: string[]) {
  setState("clearedTasks", produce((c) => ids.forEach((id) => (c[id] = true))))
}

// Files the Preview pane shows (by extension), as the server's preview serves them.
const PREVIEWABLE = /\.(html?|svg|png|jpe?g|gif|webp|avif|ico|bmp|pdf|mp4|webm|mp3|wav|ogg)$/i
export const previewable = (path: string) => PREVIEWABLE.test(path)

/** Show a workspace file (relative path) in the Preview pane; showing it again reloads it. */
export function openPreview(path: string) {
  const { history, at } = state.preview
  if (history[at] === path) setState("preview", "reload", (n) => n + 1)
  else setState("preview", { history: [...history.slice(0, at + 1), path], at: at + 1 })
  setState({ pane: "preview", paneExpanded: state.pane === "preview" && state.paneExpanded })
}

export function stepPreview(by: 1 | -1) {
  const at = state.preview.at + by
  if (at >= 0 && at < state.preview.history.length) setState("preview", "at", at)
}

export function reloadPreview() {
  setState("preview", "reload", (n) => n + 1)
}

/** Settings → Auto-open files Claude writes: an HTML page, image, PDF or video Claude just wrote or
 * edited opens in the Preview pane. */
function autoOpen(messages: RawMessage[], m: any) {
  if (!prefs.autoOpen || !Array.isArray(m.message?.content)) return
  for (const b of m.message.content) {
    if (b?.type !== "tool_result" || b.is_error) continue
    const call = messages.findLast((x) => x.type === "assistant" && Array.isArray(x.message?.content) && x.message.content.some((c: any) => c.id === b.tool_use_id))
    const tool = call?.message.content.find((c: any) => c.id === b.tool_use_id)
    const file = String(tool?.input?.file_path ?? "")
    if (["Write", "Edit", "MultiEdit"].includes(tool?.name) && file.startsWith(`${WORKSPACE}/`) && previewable(file)) {
      queueMicrotask(() => openPreview(file.slice(WORKSPACE.length + 1)))
    }
  }
}

export function openFileInPane(path: string) {
  setState({ pane: "files", openFile: path, openFiles: state.openFiles.includes(path) ? state.openFiles : [...state.openFiles, path] })
}

export function closeFile(path: string) {
  const rest = state.openFiles.filter((f) => f !== path)
  setState({ openFiles: rest, openFile: state.openFile === path ? (rest.at(-1) ?? null) : state.openFile })
}

export function setComposerText(text: string | null) {
  setState("composerText", text)
}

/** Rewind to before a message: its files go back, it and what followed leave the conversation,
 * and its text returns to the composer. */
export async function rewindTo(sessionId: string, userMessageId: string) {
  try {
    const { text, files } = await call<{ text: string; files: { canRewind: boolean; error?: string } }>("session/rewind", { sessionId, userMessageId })
    setState(
      "sessions",
      sessionId,
      produce((s) => {
        const at = s.messages.findIndex((m) => m.uuid === userMessageId)
        if (at >= 0) s.messages = s.messages.slice(0, at)
        s.rewound = userMessageId
        s.ended = null
      }),
    )
    setState("changesVersion", (v) => v + 1)
    setComposerText(text)
    if (files && !files.canRewind && files.error) showToast(`Files weren't rewound: ${files.error}`)
  } catch (error) {
    report(error)
  }
}

/** Bring back the messages a rewind removed; the files stay as they are. */
export async function undoRewind(sessionId: string) {
  try {
    await call("session/undoRewind", { sessionId })
    setState("sessions", sessionId, { loaded: false, rewound: null })
    await openSession(sessionId)
  } catch (error) {
    report(error)
  }
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

export function openSettings(page: SettingsPage = state.settings ?? "general") {
  setState({ settings: page, palette: null, shortcuts: false })
}

export function closeSettings() {
  setState("settings", null)
}

export function toggleShortcuts() {
  setState({ shortcuts: !state.shortcuts, palette: null })
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
