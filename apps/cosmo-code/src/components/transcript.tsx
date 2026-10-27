// The transcript: "Started on this computer", user bubbles (hover: Copy, Fork from here), replies
// as markdown (hover: Copy, Fork from here), tool rows labelled by what they do (expand for the
// command and output, or the edit's diff), thinking rows, then the reply streaming in, the card
// the engine is waiting on, and the working indicator.
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { structuredPatch } from "diff"
import { Icon } from "../icons"
import { copy, dismiss, fork, FOLDER, requestFor, send, state, type RawMessage, type Session } from "../store"
import { editStats, isEdit, outcome, resultText, rowLabel, type ToolResult, type ToolUse } from "../tools"
import { RequestCard } from "./cards"

type Item =
  | { kind: "user"; key: string; text: string; uuid?: string }
  | { kind: "text"; key: string; text: string; uuid?: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tool"; key: string; tool: ToolUse }

/** Text the engine adds around a prompt (reminders, command wrappers) isn't the candidate's. */
const isContext = (text: string) => /^\s*<(system-reminder|local-command|command-name|command-message|command-args)/.test(text)

function userText(content: unknown): string | null {
  if (typeof content === "string") return isContext(content) ? null : content
  if (!Array.isArray(content)) return null
  if (content.some((b: any) => b?.type === "tool_result")) return null
  const text = content
    .filter((b: any) => b?.type === "text" && !isContext(b.text ?? ""))
    .map((b: any) => b.text)
    .join("\n")
  return text || null
}

// The app's own tools (the engine host's "cosmo_turn" server) draw the task list and the next-step
// box instead of a row.
const APP_TOOL = "mcp__cosmo_turn__"
type TaskItem = { content: string; status: "pending" | "in_progress" | "completed" }
type WrapUp = { id: string; recap: string; ask?: string; actions?: { label: string; message?: string }[] }

function flatten(messages: RawMessage[]) {
  const items: Item[] = []
  const results = new Map<string, ToolResult>()
  // The latest task list and next-step box since the candidate's last message.
  const latest: { tasks: TaskItem[] | null; wrap: WrapUp | null } = { tasks: null, wrap: null }
  messages.forEach((m, n) => {
    // Subagents' own messages belong in the subagent pane, not the main transcript.
    if (m.parent_tool_use_id) return
    const content = m.message?.content
    if (m.type === "user") {
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === "tool_result") results.set(b.tool_use_id, { content: b.content, is_error: b.is_error })
      }
      const text = userText(content)
      if (text) {
        items.push({ kind: "user", key: m.uuid ?? `u${n}`, text, uuid: m.uuid })
        latest.tasks = null
        latest.wrap = null
      }
      return
    }
    if (m.type !== "assistant" || !Array.isArray(content)) return
    content.forEach((b: any, i: number) => {
      const key = `${m.uuid ?? `a${n}`}-${i}`
      if (b.type === "text" && b.text?.trim()) items.push({ kind: "text", key, text: b.text, uuid: m.uuid })
      else if (b.type === "thinking" && b.thinking?.trim()) items.push({ kind: "thinking", key, text: b.thinking })
      else if (b.type === "tool_use" && b.name === `${APP_TOOL}update_plan`) latest.tasks = b.input?.items ?? null
      else if (b.type === "tool_use" && b.name === `${APP_TOOL}wrap_up`) latest.wrap = { id: b.id, ...b.input }
      else if (b.type === "tool_use" && !String(b.name).startsWith(APP_TOOL)) items.push({ kind: "tool", key, tool: { id: b.id, name: b.name, input: b.input } })
    })
  })
  return { items, results, ...latest }
}

function MessageActions(props: { text: string; uuid?: string; sessionId: string; what: string }) {
  return (
    <div class="cc-msg-actions" role="toolbar" aria-label="Message actions">
      <button class="cc-icon-btn cc-small" aria-label="Copy" onClick={() => void copy(props.text, props.what)}>
        <Icon name="copy" size={14} />
      </button>
      <button
        class="cc-icon-btn cc-small"
        aria-label="Fork from here"
        title="Starts a new session from this point. This one stays as it is."
        disabled={!props.uuid}
        onClick={() => void fork(props.sessionId, props.uuid)}
      >
        <Icon name="fork" size={14} />
      </button>
    </div>
  )
}

function DiffView(props: { tool: ToolUse }) {
  const lines = createMemo(() => {
    const i = props.tool.input ?? {}
    const pairs: [string, string][] =
      props.tool.name === "Write" ? [["", String(i.content ?? "")]] : props.tool.name === "MultiEdit" ? (i.edits ?? []).map((e: any) => [String(e.old_string ?? ""), String(e.new_string ?? "")]) : [[String(i.old_string ?? ""), String(i.new_string ?? "")]]
    const out: { kind: "add" | "del" | "ctx"; text: string; no: number | null }[] = []
    for (const [before, after] of pairs) {
      const patch = structuredPatch("a", "b", before, after, "", "", { context: 2 })
      for (const hunk of patch.hunks) {
        let newNo = hunk.newStart
        for (const line of hunk.lines) {
          if (line.startsWith("\\")) continue
          const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx"
          out.push({ kind, text: line.slice(1), no: kind === "del" ? null : newNo++ })
        }
      }
    }
    return out
  })
  return (
    <table class="cc-diff">
      <tbody>
        <For each={lines()}>
          {(line) => (
            <tr data-kind={line.kind}>
              <td class="cc-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
              <td class="cc-diff-no">{line.no ?? ""}</td>
              <td class="cc-diff-code">{line.text}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}

function ToolRow(props: { tool: ToolUse; result?: ToolResult }) {
  const [open, setOpen] = createSignal(false)
  const label = () => rowLabel(props.tool, props.result)
  const done = () => !!props.result
  const end = () => outcome(props.tool, props.result)
  const stats = () => (isEdit(props.tool.name) ? editStats(props.tool) : null)
  const output = () => resultText(props.result)
  return (
    <section class="cc-tool" aria-label={done() ? label().done : label().running}>
      <button class="cc-tool-row" aria-expanded={open()} onClick={() => setOpen((v) => !v)}>
        <Show when={!done()}>
          <span class="cc-dots" aria-label="running" />
        </Show>
        <span class="cc-tool-label">{done() ? label().done : label().running}</span>
        <Show when={label().target}>
          <span class="cc-tool-target">{label().target}</span>
        </Show>
        <Show when={stats()}>
          {(s) => (
            <span class="cc-stat">
              <span class="cc-add">+{s().add}</span> <span class="cc-del">−{s().del}</span>
            </span>
          )}
        </Show>
        <Show when={end()}>
          {(e) => <span class="cc-tool-end" data-kind={e()}>{e() === "blocked" ? "Blocked" : e() === "denied" ? "Denied" : "Failed"}</span>}
        </Show>
        <Icon name={open() ? "chevronDown" : "chevronRight"} size={13} />
      </button>
      <Show when={open()}>
        <div class="cc-tool-body">
          <Switch fallback={<pre class="cc-output">{JSON.stringify(props.tool.input, null, 2)}{output() ? `\n\n${output()}` : ""}</pre>}>
            <Match when={props.tool.name === "Bash"}>
              <div class="cc-tool-name">Bash</div>
              <div class="cc-command">
                <code>
                  <span class="cc-muted">$ </span>
                  {props.tool.input?.command}
                </code>
                <button class="cc-icon-btn cc-small" aria-label="Copy" onClick={() => void copy(String(props.tool.input?.command ?? ""), "Command")}>
                  <Icon name="copy" size={14} />
                </button>
              </div>
              <Show when={output()}>
                <pre class="cc-output" role="region" aria-label="Tool output">
                  {output()}
                </pre>
              </Show>
            </Match>
            <Match when={isEdit(props.tool.name)}>
              <div class="cc-tool-name">{props.tool.input?.file_path}</div>
              <DiffView tool={props.tool} />
              <Show when={end()}>
                <pre class="cc-output">{output()}</pre>
              </Show>
            </Match>
            <Match when={props.tool.name === "Read" || props.tool.name === "Grep" || props.tool.name === "Glob"}>
              <pre class="cc-output" role="region" aria-label="Tool output">
                {output().slice(0, 20_000)}
              </pre>
            </Match>
          </Switch>
        </div>
      </Show>
    </section>
  )
}

/** An answered question (S33b): the question and the answer given; the card is gone. */
function AnsweredQuestions(props: { tool: ToolUse; result?: ToolResult }) {
  const answers = () => {
    const text = resultText(props.result)
    return new Map([...text.matchAll(/"([^"]+)"="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]))
  }
  return (
    <Show when={props.result}>
      <For each={props.tool.input?.questions ?? []}>
        {(q: any) => (
          <div class="cc-answered">
            <div class="cc-answered-q">{q.question}</div>
            <div class="cc-muted">{answers().get(q.question) ?? (props.result?.is_error ? "Skipped" : "")}</div>
          </div>
        )}
      </For>
    </Show>
  )
}

export function Transcript(props: { session: Session }) {
  const flat = createMemo(() => flatten(props.session.messages))
  const request = () => requestFor(props.session.id)
  const working = () => props.session.state === "running"
  // The next-step box shows once the turn is over, until dismissed or the next message.
  const nextStep = () => {
    const wrap = flat().wrap
    return !working() && wrap && !state.dismissed[wrap.id] ? wrap : undefined
  }
  // The call the engine is asking about shows under its card ("Running …"), as in the original.
  const pending = () => {
    const id = request()?.params?.toolUseID
    return flat().items.find((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool" && i.tool.id === id)
  }
  return (
    <div class="cc-transcript">
      <p class="cc-started">
        Started on this computer · {FOLDER} ·{" "}
        <button class="cc-link-btn" disabled title="Not available in this task">
          Save as environment
        </button>
      </p>
      <Show when={props.session.loaded} fallback={<div class="cc-muted cc-loading">Loading…</div>}>
        <For each={flat().items}>
          {(item) => (
            <Switch>
              <Match when={item.kind === "user" && item}>
                {(u) => (
                  <div class="cc-user">
                    <h2 class="cc-sr">You said: {u().text.slice(0, 200)}</h2>
                    <div class="cc-bubble">{u().text}</div>
                    <MessageActions text={u().text} uuid={u().uuid} sessionId={props.session.id} what="Message" />
                  </div>
                )}
              </Match>
              <Match when={item.kind === "text" && item}>
                {(t) => (
                  <div class="cc-reply">
                    <h2 class="cc-sr">Claude responded: {t().text.slice(0, 80)}</h2>
                    <Markdown class="cc-markdown" text={t().text} />
                    <MessageActions text={t().text} uuid={t().uuid} sessionId={props.session.id} what="Reply" />
                  </div>
                )}
              </Match>
              <Match when={item.kind === "thinking" && item}>
                {(t) => <ThinkingRow text={t().text} />}
              </Match>
              <Match when={item.kind === "tool" && item !== pending() && item}>
                {(t) => (
                  <Switch fallback={<ToolRow tool={t().tool} result={flat().results.get(t().tool.id)} />}>
                    <Match when={t().tool.name === "AskUserQuestion"}>
                      <AnsweredQuestions tool={t().tool} result={flat().results.get(t().tool.id)} />
                    </Match>
                  </Switch>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </Show>
      <Show when={props.session.streaming?.text}>
        <div class="cc-reply" aria-live="polite">
          <Markdown class="cc-markdown" text={props.session.streaming!.text} streaming />
        </div>
      </Show>
      <Show when={request()}>{(r) => <RequestCard request={r()} session={props.session} />}</Show>
      <Show when={pending() && !["ExitPlanMode", "AskUserQuestion"].includes(pending()!.tool.name) && pending()}>
        {(t) => <ToolRow tool={t().tool} />}
      </Show>
      <Show when={working() && flat().tasks}>{(tasks) => <TaskList items={tasks()} />}</Show>
      <Show when={working() && !request()}>
        <div class="cc-working">
          <span class="cc-dots" />
          <span class="cc-sr">Claude is responding</span>
        </div>
      </Show>
      <Show when={nextStep()}>{(wrap) => <NextStep wrap={wrap()} />}</Show>
      <Show when={state.queued[props.session.id]?.length}>
        <For each={state.queued[props.session.id]}>{(text) => <div class="cc-user cc-queued"><div class="cc-bubble">{text}</div></div>}</For>
      </Show>
    </div>
  )
}

function ThinkingRow(props: { text: string }) {
  const [open, setOpen] = createSignal(false)
  return (
    <section class="cc-tool">
      <button class="cc-tool-row cc-thinking" aria-expanded={open()} onClick={() => setOpen((v) => !v)}>
        <span class="cc-tool-label cc-ellipsis">{props.text.split("\n")[0]}</span>
        <Icon name={open() ? "chevronDown" : "chevronRight"} size={13} />
      </button>
      <Show when={open()}>
        <div class="cc-tool-body cc-thought">{props.text}</div>
      </Show>
    </section>
  )
}

/** The task list (S28): under the latest message while the turn runs. */
function TaskList(props: { items: TaskItem[] }) {
  const label = { completed: "Completed", in_progress: "In progress", pending: "Pending" }
  return (
    <ul class="cc-tasks" aria-label="Task list">
      <For each={props.items}>
        {(item) => (
          <li class="cc-task" data-status={item.status}>
            <span class="cc-task-mark" aria-label={label[item.status]} />
            <span>{item.content}</span>
          </li>
        )}
      </For>
    </ul>
  )
}

/** The next-step box (S29): recap, then a question with its answers; the first is primary (Ctrl+Enter). */
function NextStep(props: { wrap: WrapUp }) {
  const act = (a: { label: string; message?: string }) => {
    dismiss(props.wrap.id)
    void send(a.message?.trim() || a.label)
  }
  const onKey = (e: KeyboardEvent) => {
    const prompt = document.querySelector(".cc-prompt") as HTMLTextAreaElement | null
    const primary = props.wrap.actions?.[0]
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && primary && !prompt?.value.trim()) {
      e.preventDefault()
      e.stopPropagation()
      act(primary)
    }
  }
  document.addEventListener("keydown", onKey, true)
  onCleanup(() => document.removeEventListener("keydown", onKey, true))
  return (
    <section class="cc-next" aria-label="Next step">
      <div class="cc-next-head">
        <p class="cc-next-recap">{props.wrap.recap}</p>
        <button class="cc-icon-btn cc-small" aria-label="Dismiss" onClick={() => dismiss(props.wrap.id)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <Show when={props.wrap.ask}>
        <p class="cc-next-ask">{props.wrap.ask}</p>
      </Show>
      <Show when={props.wrap.actions?.length}>
        <div class="cc-next-actions">
          <For each={props.wrap.actions}>
            {(a, i) => (
              <button class={`cc-btn ${i() === 0 ? "cc-primary" : ""}`} aria-keyshortcuts={i() === 0 ? "Control+Enter" : undefined} onClick={() => act(a)}>
                {a.label}
                <Show when={i() === 0}>
                  <kbd>Ctrl</kbd>
                  <kbd>⏎</kbd>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
