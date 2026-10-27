// App state, kept in step with the engine's notifications.
import { createStore, produce } from "solid-js/store"
import { call, EngineError, listen, respond, type EngineMessage } from "./engine"
import type { Thread } from "./protocol/v2/Thread"
import type { Turn } from "./protocol/v2/Turn"
import type { ThreadItem } from "./protocol/v2/ThreadItem"
import type { Model } from "./protocol/v2/Model"
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse"
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse"
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse"
import type { ModelListResponse } from "./protocol/v2/ModelListResponse"
import type { UserInput } from "./protocol/v2/UserInput"
import { undoDiff } from "./diff"

export const WORKSPACE = import.meta.env.VITE_WORKSPACE ?? "/usercode/FILESYSTEM"
export const PROJECT = WORKSPACE.split("/").filter(Boolean).pop() ?? "workspace"

export type TurnView = Omit<Turn, "items"> & { items: ThreadItem[]; startedAtMs: number }
export type ThreadView = Thread & { loaded: TurnView[] | null }
export type Page = "home" | "thread" | "scheduled" | "plugins" | "explore"
export type ChangesScope = "lastTurn" | "uncommitted" | "unstaged" | "staged"

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
  /** The tabs pane (right of the chat): only the Changes tab so far. */
  tabs: { open: false, scope: "lastTurn" as ChangesScope, turnId: null as string | null, wrap: false, refresh: 0 },
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
  // History (and engines that don't send turn/diff/updated): rebuild a git-style diff from the
  // turn's file changes, whose paths are absolute and whose diffs are bare hunks.
  const rel = (p: string) => (p.startsWith(`${WORKSPACE}/`) ? p.slice(WORKSPACE.length + 1) : p)
  return turn.items
    .flatMap((i) => (i.type === "fileChange" ? i.changes : []))
    .map((c) => {
      if (c.diff.startsWith("---") || c.diff.startsWith("diff --git")) return c.diff
      const from = c.kind.type === "add" ? "/dev/null" : `a/${rel(c.path)}`
      const to = c.kind.type === "delete" ? "/dev/null" : `b/${rel(c.path)}`
      return `--- ${from}\n+++ ${to}\n${c.diff.endsWith("\n") ? c.diff : c.diff + "\n"}`
    })
    .join("")
}

export const activeThread = () => (state.activeId ? state.threads[state.activeId] : undefined)
export const threadOrder = () =>
  Object.values(state.threads).sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
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
    case "turn/completed":
      setState("tabs", "refresh", (n) => n + 1) // the workspace may have changed
      return withTurn(p.threadId, p.turn.id, (turn) => {
        turn.status = p.turn.status
        turn.error = p.turn.error
        turn.durationMs = p.turn.durationMs ?? Date.now() - turn.startedAtMs
      })
    case "item/started":
    case "item/completed":
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
    const session = await (await fetch("/api/session")).json()
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
export async function send(text: string, mode: "plan" | "default" = state.planMode ? "plan" : "default") {
  const input: UserInput[] = [{ type: "text", text, text_elements: [] }]
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

export function openChanges(turnId: string | null, scope: ChangesScope = "lastTurn") {
  setState("tabs", { open: true, scope, turnId })
}

export function closeTabs() {
  setState("tabs", "open", false)
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

export function start() {
  listen(onMessage)
}
