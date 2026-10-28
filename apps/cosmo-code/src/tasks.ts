// Background tasks (S32): the subagents a session started (Agent calls) and its background shell
// commands. The engine reports them live (task_started / task_updated / task_notification); a
// session's history shows them too: the call, the id its result names, and the notification the
// engine wrote when the task ended.
import type { RawMessage, Session } from "./store"

export type TaskStatus = "running" | "completed" | "failed" | "stopped"
export type BackgroundTask = {
  id: string
  /** The Agent (or Bash) call that started it. */
  toolUseId?: string
  kind: "agent" | "shell" | "other"
  description: string
  subagentType?: string
  prompt?: string
  status: TaskStatus
  summary?: string
}

const STATUS: Record<string, TaskStatus> = {
  pending: "running",
  running: "running",
  paused: "running",
  completed: "completed",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
}
export const statusOf = (status: string | undefined): TaskStatus => STATUS[status ?? ""] ?? "running"
export const kindOf = (taskType: string | undefined): BackgroundTask["kind"] =>
  taskType === "local_agent" ? "agent" : taskType === "local_bash" ? "shell" : "other"

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (typeof b === "string" ? b : (b?.text ?? ""))).join("\n") : ""

const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim()

/** The tasks a session's messages show. `running`: whether the session is still working (a task
 * with no end recorded is then still running; otherwise it was stopped with the engine). */
export function historyTasks(messages: RawMessage[], running: boolean): BackgroundTask[] {
  const results = new Map<string, { text: string; error: boolean }>()
  const ended = new Map<string, { status: TaskStatus; summary?: string }>()
  for (const m of messages) {
    if (m.type !== "user" || m.parent_tool_use_id) continue
    const content = m.message?.content
    if (Array.isArray(content)) for (const b of content) if (b?.type === "tool_result") results.set(b.tool_use_id, { text: textOf(b.content), error: !!b.is_error })
    const text = textOf(content)
    if (text.includes("<task-notification>")) {
      const id = tag(text, "task-id")
      if (id) ended.set(id, { status: statusOf(tag(text, "status")), summary: tag(text, "summary") })
    }
  }
  const tasks: BackgroundTask[] = []
  for (const m of messages) {
    if (m.type !== "assistant" || m.parent_tool_use_id || !Array.isArray(m.message?.content)) continue
    for (const b of m.message.content) {
      if (b?.type !== "tool_use") continue
      const result = results.get(b.id)
      const input = b.input ?? {}
      let task: BackgroundTask | null = null
      if (b.name === "Agent" || b.name === "Task") {
        const id = /agentId:\s*([a-z0-9]+)/.exec(result?.text ?? "")?.[1] ?? b.id
        // A subagent in the foreground ends with its call; one in the background reports later.
        const background = /Async agent launched/i.test(result?.text ?? "")
        const status: TaskStatus = !result ? "running" : result.error ? "failed" : background ? (running ? "running" : "stopped") : "completed"
        task = { id, toolUseId: b.id, kind: "agent", description: String(input.description ?? "Agent"), subagentType: input.subagent_type, prompt: input.prompt, status }
      } else if (b.name === "Bash" && input.run_in_background) {
        const id = /background with ID:\s*([A-Za-z0-9_-]+)/.exec(result?.text ?? "")?.[1]
        if (!id) continue
        task = { id, toolUseId: b.id, kind: "shell", description: String(input.description ?? input.command ?? "Command"), status: running ? "running" : "stopped" }
      }
      if (!task) continue
      const end = ended.get(task.id)
      tasks.push(end ? { ...task, ...end } : task)
    }
  }
  return tasks
}

/** History, with what the engine reported live on top (and tasks only it knows of). */
export function mergeTasks(history: BackgroundTask[], live: Record<string, Partial<BackgroundTask>>): BackgroundTask[] {
  const out = history.map((t) => (live[t.id] ? { ...t, ...strip(live[t.id]!) } : t))
  for (const [id, t] of Object.entries(live)) if (!history.some((h) => h.id === id)) out.push({ kind: "other", description: "Task", status: "running", ...t, id })
  return out
}

const strip = (t: Partial<BackgroundTask>) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined))

/** A session's background tasks. */
export const tasksOf = (s: Session) => mergeTasks(historyTasks(s.messages, s.state === "running"), s.tasks)
