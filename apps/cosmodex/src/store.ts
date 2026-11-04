// App state, kept in step with the engine's notifications.
import { createStore, produce } from "solid-js/store"
import { COSMO, call, EngineError, listen, respond, type EngineMessage } from "./engine"
import type { Thread } from "./protocol/v2/Thread"
import type { Turn } from "./protocol/v2/Turn"
import type { ThreadItem } from "./protocol/v2/ThreadItem"
import type { Model } from "./protocol/v2/Model"
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse"
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse"
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse"
import type { ThreadReadResponse } from "./protocol/v2/ThreadReadResponse"
import type { ModelListResponse } from "./protocol/v2/ModelListResponse"
import type { UserInput } from "./protocol/v2/UserInput"
import { changeDiff, undoDiff } from "./diff"
import { prefs, togglePin } from "./prefs"
import type { ThreadForkResponse } from "./protocol/v2/ThreadForkResponse"
import type { TextElement } from "./protocol/v2/TextElement"
import type { ThreadTokenUsage } from "./protocol/v2/ThreadTokenUsage"
import type { SkillMetadata } from "./protocol/v2/SkillMetadata"
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse"

export const WORKSPACE = import.meta.env.VITE_WORKSPACE ?? "/usercode/FILESYSTEM"
export const PROJECT = WORKSPACE.split("/").filter(Boolean).pop() ?? "workspace"

export type TurnView = Omit<Turn, "items"> & { items: ThreadItem[]; startedAtMs: number }
export type ThreadView = Thread & { loaded: TurnView[] | null }
export type Page = "home" | "thread" | "scheduled" | "plugins" | "explore" | "settings"
export type ChangesScope = "lastTurn" | "uncommitted" | "unstaged" | "staged"
export type CommandTab = "all" | "actions" | "chats" | "files" | "text"
/** A tab of the tabs pane. Terminals keep their engine process id. */
export type PaneTab = { id: string; kind: "new" | "changes" | "file" | "terminal"; path?: string; processId?: string; title?: string }
/** What the composer sends: text with file chips (text elements), and chosen skills. */
export type Draft = { text: string; elements: TextElement[]; skills: { name: string; path: string }[] }

const [state, setState] = createStore({
  engine: "connecting" as "connecting" | "ready" | "reconnecting",
  page: "home" as Page,
  sidebar: true,
  threads: {} as Record<string, ThreadView>,
  activeId: null as string | null,
  /** Open engine requests (approvals, questions), by request id. */
  requests: {} as Record<string, EngineMessage>,
  models: [] as Model[],
  model: null as string | null,
  effort: null as string | null,
  toast: null as string | null,
  /** The composer's plan-mode toggle, and the mode each thread's last turn ran in. */
  planMode: false,
  threadMode: {} as Record<string, "plan" | "default">,
  /** Aggregated diff per turn (turn/diff/updated), and turns whose changes were undone. */
  turnDiffs: {} as Record<string, string>,
  undone: {} as Record<string, true>,
  /** Plans the candidate already answered ("Implement this plan?"), by turn. */
  planAnswered: {} as Record<string, true>,
  /** Questions the candidate answered, per turn ("Asked 1 question"). */
  questionsAsked: {} as Record<string, number>,
  /** Settings: the open page, and the engine's configuration warnings (configWarning). */
  settingsPage: "general",
  configWarnings: [] as string[],
  /** Chat being renamed (dialog), and follow-ups queued while a turn runs, by thread. */
  renaming: null as string | null,
  queued: {} as Record<string, Draft[]>,
  /** Context usage per thread (thread/tokenUsage/updated), for /status. */
  tokenUsage: {} as Record<string, ThreadTokenUsage>,
  /** The command menu's open tab (null when closed), and the skills the engine offers. */
  commandMenu: null as CommandTab | null,
  skills: [] as SkillMetadata[],
  /** Each chat's last reply, for the activity view's previews. */
  lastReply: {} as Record<string, string>,
  /** Files picked this session (command menu › Files "Opened recently"), newest first. */
  recentFiles: [] as string[],
  /** The tabs pane (right of the chat): its tabs, the selected one, full view, and the Changes tab's settings. */
  tabs: {
    open: false,
    full: false,
    list: [] as PaneTab[],
    active: null as string | null,
    scope: "lastTurn" as ChangesScope,
    turnId: null as string | null,
    wrap: false,
    refresh: 0,
  },
  /** Whether the task gives the candidate a terminal (the server's /api/session). */
  terminal: false,
  /** Whether the task offers "Approve for me" (the server's /api/session). */
  autoMode: false,
  /** Whether the task has its own web app, whose dev server the terminal must be able to run. */
  app: false,
  /** Who answers approval requests: the candidate, or Codex's review agent ("Approve for me"). */
  reviewer: "user" as "user" | "auto_review",
})
export { state }

/** A chat's title: its name, else its first message (as the original app does). */
export function threadTitle(thread: ThreadView) {
  if (thread.name) return thread.name
  if (thread.preview) return thread.preview
  for (const turn of thread.loaded ?? []) {
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = item.content.map((c) => ("text" in c ? c.text : "")).join(" ").trim()
        if (text) return text
      }
    }
  }
  return "New chat"
}

/** The turn's diff: live from turn/diff/updated, or rebuilt from its file changes (history). */
export function turnDiff(turn: TurnView): string {
  if (state.turnDiffs[turn.id]) return state.turnDiffs[turn.id]!
  // History (and engines that don't send turn/diff/updated): rebuild it from the turn's file changes.
  return turn.items
    .flatMap((i) => (i.type === "fileChange" ? i.changes : []))
    .map((c) => changeDiff(c, WORKSPACE))
    .join("")
}

/** Reasoning effort as the original labels it ("low" → "Light"). */
export function effortLabel(effort: string | null) {
  if (!effort) return ""
  const names: Record<string, string> = { none: "None", minimal: "Minimal", low: "Light", medium: "Medium", high: "High", xhigh: "Extra High" }
  return names[effort] ?? effort[0]!.toUpperCase() + effort.slice(1)
}

/** A model's display name from the catalog. */
export const modelName = (model: string | null) => state.models.find((m) => m.model === model)?.displayName ?? model ?? "Model"
export const activeThread = () => (state.activeId ? state.threads[state.activeId] : undefined)
export const threadOrder = () =>
  Object.values(state.threads)
    .filter((t) => !t.parentThreadId)
    .sort((a, b) => {
      const pin = Number(prefs.pinned.includes(b.id)) - Number(prefs.pinned.includes(a.id))
      return pin || Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0)
    })
export const requestFor = (threadId: string) =>
  Object.values(state.requests).find((r) => r.params?.threadId === threadId)

export function showToast(message: string) {
  setState("toast", message)
  setTimeout(() => setState("toast", (t) => (t === message ? null : t)), 4000)
}

function report(error: unknown) {
  console.error(error)
  showToast(error instanceof EngineError || error instanceof Error ? error.message : "Something went wrong")
}

function upsertThread(thread: Thread) {
  setState("threads", thread.id, (prev) => ({ ...thread, loaded: prev?.loaded ?? null }))
}

function turnsOf(threadId: string) {
  return state.threads[threadId]?.loaded ?? null
}

function withTurn(threadId: string, turnId: string, fn: (turn: TurnView) => void) {
  if (!turnsOf(threadId)) return
  setState(
    "threads",
    threadId,
    "loaded",
    produce((turns) => {
      const turn = turns!.find((t) => t.id === turnId)
      if (turn) fn(turn)
    }),
  )
}

function onMessage(msg: EngineMessage) {
  const p = msg.params ?? {}
  if (msg.id !== undefined) {
    setState("requests", String(msg.id), msg)
    return
  }
  switch (msg.method) {
    case "cosmodex/engine":
      setState("engine", p.state === "ready" ? "ready" : p.state === "reconnecting" ? "reconnecting" : "connecting")
      if (p.state === "ready") {
        void refreshThreads()
        if (!state.models.length) void loadModels()
      }
      return
    case "thread/started":
      return upsertThread(p.thread)
    case "thread/name/updated":
      if (state.threads[p.threadId]) setState("threads", p.threadId, "name", p.threadName ?? null)
      return
    case "thread/status/changed":
      if (state.threads[p.threadId]) setState("threads", p.threadId, "status", p.status)
      return
    case "turn/started": {
      const turns = turnsOf(p.threadId)
      if (turns && !turns.some((t) => t.id === p.turn.id)) {
        setState("threads", p.threadId, "loaded", turns.length, { ...p.turn, items: p.turn.items ?? [], startedAtMs: Date.now() })
      }
      setState("threads", p.threadId, "updatedAt", Math.floor(Date.now() / 1000) as never)
      return
    }
    case "configWarning": {
      const text = [p.summary, p.details].filter(Boolean).join(" ")
      if (!state.configWarnings.includes(text)) setState("configWarnings", state.configWarnings.length, text)
      return
    }
    case "command/exec/outputDelta":
      return terminalOutput(p.processId, p.deltaBase64)
    case "thread/tokenUsage/updated":
      return setState("tokenUsage", p.threadId, p.tokenUsage)
    case "thread/archived":
      return setState("threads", produce((t) => delete t[p.threadId]))
    case "turn/completed":
      setState("tabs", "refresh", (n) => n + 1) // the workspace may have changed
      // Follow-ups queued while this turn ran go out now, one turn each.
      queueMicrotask(() => {
        const next = state.queued[p.threadId]?.[0]
        if (next === undefined) return
        setState("queued", p.threadId, (q) => q.slice(1))
        void send(next)
      })
      return withTurn(p.threadId, p.turn.id, (turn) => {
        turn.status = p.turn.status
        turn.error = p.turn.error
        turn.durationMs = p.turn.durationMs ?? Date.now() - turn.startedAtMs
      })
    case "item/started":
    case "item/completed":
      if (msg.method === "item/completed" && p.item?.type === "agentMessage" && p.item.text) setState("lastReply", p.threadId, p.item.text)
      return withTurn(p.threadId, p.turnId, (turn) => {
        const at = turn.items.findIndex((i) => i.id === p.item.id)
        if (at >= 0) turn.items[at] = p.item
        else turn.items.push(p.item)
      })
    case "item/agentMessage/delta":
      return withTurn(p.threadId, p.turnId, (turn) => {
        const item = turn.items.find((i) => i.id === p.itemId)
        if (item?.type === "agentMessage") item.text += p.delta
      })
    case "item/plan/delta":
      return withTurn(p.threadId, p.turnId, (turn) => {
        const item = turn.items.find((i) => i.id === p.itemId)
        if (item?.type === "plan") item.text += p.delta
      })
    case "turn/diff/updated":
      return setState("turnDiffs", p.turnId, p.diff)
    case "item/commandExecution/outputDelta":
      return withTurn(p.threadId, p.turnId, (turn) => {
        const item = turn.items.find((i) => i.id === p.itemId)
        if (item?.type === "commandExecution") item.aggregatedOutput = (item.aggregatedOutput ?? "") + p.delta
      })
    case "serverRequest/resolved":
      return setState("requests", produce((r) => delete r[String(p.requestId)]))
  }
}

export async function refreshThreads() {
  try {
    const list = await call<ThreadListResponse>("thread/list", { limit: 50 })
    for (const thread of list.data) upsertThread(thread)
  } catch (error) {
    report(error)
  }
}

/** The task's default model, from the simulation shell's session (same origin). */
async function taskDefaultModel(): Promise<string | undefined> {
  try {
    const session = await (await fetch(`${COSMO}/api/session`)).json()
    return session.agents?.find((a: { id: string }) => a.id === "cosmodex")?.models?.default
  } catch {
    return undefined
  }
}

export async function loadModels() {
  try {
    const [list, preferred] = await Promise.all([call<ModelListResponse>("model/list", {}), taskDefaultModel()])
    const models = list.data.filter((m) => !m.hidden)
    setState("models", models)
    const initial = models.find((m) => m.model === preferred) ?? models[0]
    if (!state.model && initial) {
      setState("model", initial.model)
      setState("effort", initial.defaultReasoningEffort)
    }
  } catch (error) {
    report(error)
  }
}

export function goHome() {
  setState({ page: "home", activeId: null })
}

export function setPage(page: Page) {
  setState({ page, activeId: page === "thread" ? state.activeId : null })
}

export function toggleSidebar() {
  setState("sidebar", (v) => !v)
}

export function chooseModel(model: string, effort?: string | null) {
  setState("model", model)
  if (effort !== undefined) setState("effort", effort)
}

export async function openThread(id: string) {
  setState({ activeId: id, page: "thread" })
  if (state.threads[id]?.loaded) return
  try {
    const res = await call<ThreadResumeResponse>("thread/resume", { threadId: id })
    upsertThread(res.thread)
    const turns = (res.thread.turns ?? []).map((t) => ({ ...t, items: t.items ?? [], startedAtMs: Number(t.startedAt ?? 0) * 1000 }))
    setState("threads", id, "loaded", turns)
  } catch (error) {
    report(error)
  }
}

/**
 * Send a prompt: in the open thread, or in a new one from the home screen. `mode` overrides the
 * composer's plan toggle (e.g. "Implement this plan?" switches back to the default mode).
 */
export async function send(draft: string | Draft, mode: "plan" | "default" = state.planMode ? "plan" : "default") {
  const { text, elements, skills } = typeof draft === "string" ? { text: draft, elements: [], skills: [] } : draft
  const input: UserInput[] = [{ type: "text", text, text_elements: elements }, ...skills.map((k) => ({ type: "skill" as const, ...k }))]
  const running = state.activeId ? state.threads[state.activeId]?.loaded?.at(-1) : undefined
  if (running?.status === "inProgress") {
    // Follow-up behaviour: steer the current run, or queue for after it.
    if (prefs.followUp === "Steer") {
      try {
        await call("turn/steer", { threadId: state.activeId, input, expectedTurnId: running.id })
      } catch (error) {
        report(error)
      }
    } else {
      setState("queued", state.activeId!, (q) => [...(q ?? []), { text, elements, skills }])
    }
    return
  }
  try {
    let id = state.activeId
    if (!id) {
      const started = await call<ThreadStartResponse>("thread/start", state.model ? { model: state.model } : {})
      upsertThread(started.thread)
      setState("threads", started.thread.id, "loaded", [])
      id = started.thread.id
      setState({ activeId: id, page: "thread" })
    }
    // The mode is sent when it is plan, and when leaving plan (it sticks to the thread otherwise).
    const needsMode = mode === "plan" || state.threadMode[id] === "plan"
    const collaborationMode = needsMode
      ? { mode, settings: { model: state.model, reasoning_effort: state.effort, developer_instructions: null } }
      : undefined
    await call("turn/start", {
      threadId: id,
      input,
      ...(state.model ? { model: state.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
      approvalsReviewer: state.reviewer,
    })
    setState("threadMode", id, mode)
  } catch (error) {
    report(error)
  }
}

export function setPlanMode(on: boolean) {
  setState("planMode", on)
}

/** Answer the engine's questions (plan mode): question id -> chosen labels or typed text. */
export async function answerQuestions(requestId: string, answers: Record<string, string[]>) {
  const asked = state.requests[requestId]?.params
  try {
    await respond(requestId, { answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, { answers: a }])) })
    setState("requests", produce((r) => delete r[requestId]))
    if (asked?.turnId) setState("questionsAsked", asked.turnId, (n) => (n ?? 0) + (asked.questions?.length ?? 1))
  } catch (error) {
    report(error)
  }
}

/** "Implement this plan?": yes switches to the default mode; feedback keeps planning. */
export async function answerPlan(turnId: string, choice: { implement: true } | { feedback: string } | { skip: true }) {
  setState("planAnswered", turnId, true)
  if ("implement" in choice) {
    setState("planMode", false)
    await send("Implement the plan.", "default")
  } else if ("feedback" in choice) {
    await send(choice.feedback, "plan")
  }
}

let tabSeq = 0
const nextTabId = (kind: string) => `${kind}-${++tabSeq}`

function addTab(tab: PaneTab) {
  setState("tabs", (t) => ({ ...t, open: true, list: [...t.list, tab], active: tab.id }))
}

/** Select the first tab matching `find`, or add `make()`. */
function focusOrAdd(find: (t: PaneTab) => boolean, make: () => PaneTab) {
  const found = state.tabs.list.find(find)
  if (found) setState("tabs", { open: true, active: found.id })
  else addTab(make())
}

export function openChanges(turnId: string | null, scope: ChangesScope = "lastTurn") {
  setState("tabs", { scope, turnId })
  focusOrAdd((t) => t.kind === "changes", () => ({ id: nextTabId("changes"), kind: "changes" }))
}

/** Open a workspace file (relative path) in a file tab. */
export function openFile(path: string) {
  rememberFile(path)
  if (state.page !== "thread" && state.page !== "home") setState("page", state.activeId ? "thread" : "home")
  focusOrAdd((t) => t.kind === "file" && t.path === path, () => ({ id: nextTabId("file"), kind: "file", path }))
}

export function newTab() {
  addTab({ id: nextTabId("new"), kind: "new" })
}

export function openTerminal() {
  if (!state.terminal) return showToast("The terminal isn't available in this task.")
  const id = nextTabId("terminal")
  addTab({ id, kind: "terminal", processId: `cosmodex-${id}-${Date.now().toString(36)}` })
}

export function selectTab(id: string) {
  setState("tabs", "active", id)
}

export function stepTab(delta: number) {
  const list = state.tabs.list
  if (!list.length) return
  const at = list.findIndex((t) => t.id === state.tabs.active)
  setState("tabs", { open: true, active: list[(at + delta + list.length) % list.length]!.id })
}

export function setTabTitle(id: string, title: string) {
  setState("tabs", "list", (t) => t.id === id, "title", title)
}

export function closeTab(id: string) {
  const list = state.tabs.list
  const at = list.findIndex((t) => t.id === id)
  if (at < 0) return
  const rest = list.filter((t) => t.id !== id)
  const active = state.tabs.active === id ? (rest[Math.min(at, rest.length - 1)]?.id ?? null) : state.tabs.active
  setState("tabs", { list: rest, active, open: rest.length > 0 && state.tabs.open, full: rest.length > 0 && state.tabs.full })
}

/** "Hide tabs" keeps them; "Show tabs" brings them back (or opens a New tab). */
export function closeTabs() {
  setState("tabs", { open: false, full: false })
}

export function toggleTabs() {
  if (state.tabs.open) closeTabs()
  else if (state.tabs.list.length) setState("tabs", "open", true)
  else newTab()
}

export function toggleFullView() {
  setState("tabs", "full", (f) => !f)
}

// Terminal output arrives as engine notifications; each terminal tab listens for its process.
const terminalSinks = new Map<string, (bytes: Uint8Array) => void>()
const terminalBacklog = new Map<string, Uint8Array[]>()

export function onTerminalOutput(processId: string, sink: (bytes: Uint8Array) => void) {
  terminalSinks.set(processId, sink)
  for (const chunk of terminalBacklog.get(processId) ?? []) sink(chunk)
  terminalBacklog.delete(processId)
  return () => terminalSinks.delete(processId)
}

function terminalOutput(processId: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const sink = terminalSinks.get(processId)
  if (sink) sink(bytes)
  else terminalBacklog.set(processId, [...(terminalBacklog.get(processId) ?? []), bytes])
}

export function setChangesScope(scope: ChangesScope) {
  setState("tabs", "scope", scope)
}

export function toggleWrap() {
  setState("tabs", "wrap", (w) => !w)
}

export async function undoTurn(turnId: string) {
  const turn = Object.values(state.threads)
    .flatMap((t) => t.loaded ?? [])
    .find((t) => t.id === turnId)
  const diff = turn ? turnDiff(turn) : ""
  if (!diff) return showToast("Nothing to undo for this turn.")
  try {
    const result = await undoDiff(WORKSPACE, diff)
    if (!result.ok) return showToast(`Can't undo: ${result.path} changed since this turn.`)
    setState("undone", turnId, true)
    setState("tabs", "refresh", (n) => n + 1)
    showToast("Changes undone")
  } catch (error) {
    report(error)
  }
}

export async function stop(threadId: string, turnId: string) {
  try {
    await call("turn/interrupt", { threadId, turnId })
  } catch (error) {
    report(error)
  }
}

export async function answer(requestId: string, decision: string) {
  try {
    await respond(requestId, { decision })
    setState("requests", produce((r) => delete r[requestId]))
  } catch (error) {
    report(error)
  }
}

/** The composer's permissions menu: "Ask for approval" or, when the task offers it, "Approve for me". */
export function setReviewer(reviewer: "user" | "auto_review") {
  if (reviewer === "auto_review" && !state.autoMode) return
  setState("reviewer", reviewer)
}

export function start() {
  listen(onMessage)
  void fetch(`${COSMO}/api/session`)
    .then((res) => (res.ok ? res.json() : undefined))
    .then((session) => setState({ terminal: !!session?.terminal && session.terminal !== "off", autoMode: !!session?.autoMode, app: !!session?.app }))
    .catch(() => setState("terminal", false))
}

// Chat actions (thread "…" menu, sidebar row icons, shortcuts).

export function openSettings(page = state.settingsPage) {
  setState({ page: "settings", settingsPage: page, activeId: null })
}

export function startRename(threadId: string) {
  setState("renaming", threadId)
}

export async function rename(threadId: string, name: string) {
  setState("renaming", null)
  const clean = name.trim()
  if (!clean) return
  try {
    await call("thread/name/set", { threadId, name: clean })
    setState("threads", threadId, "name", clean)
  } catch (error) {
    report(error)
  }
}

export function pin(threadId: string) {
  togglePin(threadId)
}

export async function fork(threadId: string) {
  try {
    const res = await call<ThreadForkResponse>("thread/fork", { threadId })
    upsertThread(res.thread)
    setState("threads", res.thread.id, "loaded", null)
    await openThread(res.thread.id)
    showToast("Forked chat")
  } catch (error) {
    report(error)
  }
}

export async function archive(threadId: string) {
  try {
    await call("thread/archive", { threadId })
    setState("threads", produce((t) => delete t[threadId]))
    if (state.activeId === threadId) goHome()
    showToast("Chat archived")
  } catch (error) {
    report(error)
  }
}

export async function unarchive(threadId: string) {
  try {
    await call("thread/unarchive", { threadId })
    await refreshThreads()
  } catch (error) {
    report(error)
  }
}

export async function archivedThreads(): Promise<Thread[]> {
  try {
    return (await call<ThreadListResponse>("thread/list", { archived: true, limit: 100 })).data
  } catch (error) {
    report(error)
    return []
  }
}

/** The chat as Markdown (user messages as quotes, replies as they are). */
export function threadMarkdown(thread: ThreadView) {
  const parts: string[] = [`# ${threadTitle(thread)}`]
  for (const turn of thread.loaded ?? []) {
    for (const item of turn.items) {
      if (item.type === "userMessage") parts.push(item.content.map((c) => ("text" in c ? `> ${c.text}` : "")).join("\n"))
      else if (item.type === "agentMessage") parts.push(item.text)
      else if (item.type === "plan") parts.push(item.text)
      else if (item.type === "commandExecution") parts.push("```sh\n$ " + item.command + "\n```")
    }
  }
  return parts.filter(Boolean).join("\n\n") + "\n"
}

export async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast(`${what} copied`)
  } catch {
    showToast(`Couldn't copy the ${what.toLowerCase()}.`)
  }
}

// Command menu and composer popovers.

export function openCommandMenu(tab: CommandTab = "all") {
  setState("commandMenu", tab)
}

export function closeCommandMenu() {
  setState("commandMenu", null)
}

export async function loadSkills() {
  try {
    const res = await call<SkillsListResponse>("skills/list", { cwds: [WORKSPACE] })
    setState("skills", res.data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled))
  } catch (error) {
    console.warn("Skills could not be listed", error)
  }
}

/** Threads' turns, loading the ones not opened yet (for the command menu's text search). */
export async function loadTurns(threadId: string): Promise<TurnView[]> {
  const loaded = state.threads[threadId]?.loaded
  if (loaded) return loaded
  try {
    const res = await call<ThreadReadResponse>("thread/read", { threadId, includeTurns: true })
    return (res.thread.turns ?? []).map((t) => ({ ...t, items: t.items ?? [], startedAtMs: 0 })) as TurnView[]
  } catch {
    return []
  }
}

export function rememberFile(path: string) {
  setState("recentFiles", (files) => [path, ...files.filter((f) => f !== path)].slice(0, 10))
}

/** A chat's last reply (from its history, once) for the activity view. */
export async function loadReply(threadId: string) {
  if (state.lastReply[threadId] !== undefined) return
  setState("lastReply", threadId, "")
  const turns = await loadTurns(threadId)
  const items = turns.flatMap((t) => t.items)
  const last = items.findLast((i) => i.type === "agentMessage" && i.text)
  if (last?.type === "agentMessage") setState("lastReply", threadId, last.text)
}
