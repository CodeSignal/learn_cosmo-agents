// The thread: user bubbles, assistant replies (markdown, streamed), tool rows that expand
// ("Ran …" → Shell card, "Created/Edited …"), and the turn line ("Working for Ns" → "Worked for
// Ns" / "You stopped after Ns").
import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { Icon } from "../icons"
import { Composer } from "./composer"
import { ApprovalCard } from "./approval"
import { openChanges, requestFor, state, threadTitle, turnDiff, undoTurn, type ThreadView, type TurnView } from "../store"
import { ChangesPane } from "./changes"
import { ChatActionsMenu } from "./chat-actions"
import { ImplementPrompt, PlanCard, proposedPlan, QuestionCard, withoutPlan } from "./plan"
import { parseDiff, totals } from "../diff"
import type { ThreadItem } from "../protocol/v2/ThreadItem"

const [now, setNow] = createSignal(Date.now())
setInterval(() => setNow(Date.now()), 1000)

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`

function turnLine(turn: TurnView) {
  if (turn.status === "inProgress") return `Working for ${seconds(now() - turn.startedAtMs)}`
  const took = turn.durationMs ?? 0
  if (turn.status === "interrupted") return `You stopped after ${seconds(took)}`
  return `Worked for ${seconds(took)}`
}

function diffStats(diff: string) {
  let add = 0
  let del = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++
    else if (line.startsWith("-") && !line.startsWith("---")) del++
  }
  return { add, del }
}

const base = (p: string) => p.split("/").pop() ?? p

function CommandRow(props: { item: Extract<ThreadItem, { type: "commandExecution" }> }) {
  const [open, setOpen] = createSignal(false)
  const done = () => props.item.status !== "inProgress"
  const ok = () => props.item.exitCode === 0
  return (
    <div class="cx-tool">
      <button class="cx-tool-row" aria-expanded={open()} onClick={() => setOpen((v) => !v)}>
        <Icon name="terminal" size={14} />
        <span>{done() ? "Ran" : "Running"}</span>
        <code class="cx-tool-cmd">{props.item.command}</code>
      </button>
      <Show when={open()}>
        <div class="cx-shell">
          <div class="cx-shell-head">Shell</div>
          <pre class="cx-shell-cmd">$ {props.item.command}</pre>
          <Show when={props.item.aggregatedOutput}>
            <pre class="cx-shell-out">{props.item.aggregatedOutput}</pre>
          </Show>
          <Show when={done()}>
            <div class="cx-shell-foot" data-ok={ok() ? "" : undefined}>
              {ok() ? "✓ Success" : `Exited with code ${props.item.exitCode ?? "?"}`}
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function FileChangeRows(props: { item: Extract<ThreadItem, { type: "fileChange" }> }) {
  return (
    <For each={props.item.changes}>
      {(change) => {
        const stats = diffStats(change.diff ?? "")
        const verb = change.kind.type === "add" ? "Created" : change.kind.type === "delete" ? "Deleted" : "Edited"
        return (
          <div class="cx-tool-row cx-static">
            <Icon name="pencil" size={14} />
            <span>{verb}</span>
            <span class="cx-file-link">{base(change.path)}</span>
            <span class="cx-add">+{stats.add}</span>
            <span class="cx-del">-{stats.del}</span>
          </div>
        )
      }}
    </For>
  )
}

function Item(props: { item: ThreadItem; streaming: boolean }) {
  return (
    <Switch fallback={<div class="cx-tool-row cx-static">Used {(props.item as { tool?: string }).tool ?? props.item.type}</div>}>
      <Match when={props.item.type === "userMessage" && props.item}>
        {(item) => (
          <div class="cx-user">
            <div class="cx-bubble">
              {item()
                .content.map((c) => ("text" in c ? c.text : ""))
                .join("\n")}
            </div>
          </div>
        )}
      </Match>
      <Match when={props.item.type === "agentMessage" && props.item}>
        {(item) => (
          <>
            <Show when={withoutPlan(item().text)}>
              <Markdown class="cx-assistant" text={withoutPlan(item().text)} streaming={props.streaming} />
            </Show>
            <Show when={proposedPlan(item().text)}>{(plan) => <PlanCard plan={plan()} />}</Show>
          </>
        )}
      </Match>
      <Match when={props.item.type === "reasoning"}>
        <div class="cx-status-line">Thinking</div>
      </Match>
      <Match when={props.item.type === "commandExecution" && props.item}>{(item) => <CommandRow item={item()} />}</Match>
      <Match when={props.item.type === "fileChange" && props.item}>{(item) => <FileChangeRows item={item()} />}</Match>
      <Match when={props.item.type === "plan" && props.item}>{(item) => <PlanCard plan={item().text} />}</Match>
      <Match when={props.item.type === "contextCompaction"}>
        <div class="cx-status-line">Context compacted</div>
      </Match>
    </Switch>
  )
}

/** After a turn that changed files: count, +/-, Undo and View changes. */
function TurnSummary(props: { turn: TurnView }) {
  const files = () => parseDiff(turnDiff(props.turn))
  const sum = () => totals(files())
  const undone = () => !!state.undone[props.turn.id]
  return (
    <div class="cx-summary" data-undone={undone() ? "" : undefined}>
      <Icon name="diff" size={14} />
      <span>
        {files().length} {files().length === 1 ? "file" : "files"} changed
      </span>
      <span class="cx-add">+{sum().add}</span>
      <span class="cx-del">-{sum().del}</span>
      <div class="cx-grow" />
      <Show when={!undone()} fallback={<span class="cx-menu-subtitle">Undone</span>}>
        <button class="cx-btn cx-small-btn" onClick={() => void undoTurn(props.turn.id)}>
          Undo <Icon name="undo" size={13} />
        </button>
      </Show>
      <button class="cx-btn cx-small-btn" aria-label="View changed files" onClick={() => openChanges(props.turn.id)}>
        View changes
      </button>
    </div>
  )
}

function Turn(props: { turn: TurnView }) {
  const user = () => props.turn.items.filter((i) => i.type === "userMessage")
  const rest = () => props.turn.items.filter((i) => i.type !== "userMessage")
  return (
    <section class="cx-turn">
      <For each={user()}>{(item) => <Item item={item} streaming={false} />}</For>
      <div class="cx-turn-line">
        <span>{turnLine(props.turn)}</span>
        <span class="cx-turn-rule" />
      </div>
      <Show when={state.questionsAsked[props.turn.id]}>
        {(n) => <div class="cx-status-line">Asked {n()} {n() === 1 ? "question" : "questions"}</div>}
      </Show>
      <For each={rest()}>{(item) => <Item item={item} streaming={props.turn.status === "inProgress"} />}</For>
      <Show when={Object.values(state.requests).some((r) => r.params?.turnId === props.turn.id && r.method === "item/tool/requestUserInput")}>
        <div class="cx-status-line">Waiting for your answer</div>
      </Show>
      <Show when={props.turn.status !== "inProgress" && props.turn.items.some((i) => i.type === "fileChange")}>
        <TurnSummary turn={props.turn} />
      </Show>
      <Show when={props.turn.error}>
        <div class="cx-error">{(props.turn.error as { message?: string })?.message ?? "The turn failed."}</div>
      </Show>
    </section>
  )
}

export function ThreadPage(props: { thread: ThreadView }) {
  let scroller!: HTMLDivElement
  const pending = () => requestFor(props.thread.id)
  const lastTurn = () => props.thread.loaded?.at(-1)
  // "Implement this plan?" follows a finished turn that proposed a plan, until it's answered.
  const planToAnswer = () => {
    const turn = lastTurn()
    if (!turn || turn.status !== "completed" || state.planAnswered[turn.id]) return null
    const hasPlan = turn.items.some((i) => i.type === "plan" || (i.type === "agentMessage" && proposedPlan(i.text)))
    return hasPlan ? turn.id : null
  }
  const follow = new MutationObserver(() => {
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160) scroller.scrollTop = scroller.scrollHeight
  })
  onCleanup(() => follow.disconnect())
  return (
    <div class="cx-split-main">
    <div class="cx-chat">
      <header class="cx-thread-head">
        <Icon name="folder" size={14} />
        <span class="cx-thread-head-title">{threadTitle(props.thread)}</span>
        <div class="cx-grow" />
        <ChatActionsMenu thread={props.thread} />
      </header>
      <div
        class="cx-conversation"
        ref={(el) => {
          scroller = el
          follow.observe(el, { childList: true, subtree: true, characterData: true })
        }}
      >
        <Show when={props.thread.loaded} fallback={<div class="cx-loading">Loading…</div>}>
          <For each={props.thread.loaded!}>{(turn) => <Turn turn={turn} />}</For>
        </Show>
      </div>
      <div class="cx-bottom">
        <Switch fallback={<Composer thread={props.thread} />}>
          <Match when={pending()?.method === "item/tool/requestUserInput" && pending()}>{(req) => <QuestionCard request={req()} />}</Match>
          <Match when={pending()}>{(req) => <ApprovalCard request={req()} />}</Match>
          <Match when={planToAnswer()}>{(turnId) => <ImplementPrompt turnId={turnId()} />}</Match>
        </Switch>
      </div>
    </div>
    <Show when={state.tabs.open}>
      <ChangesPane />
    </Show>
    </div>
  )
}
