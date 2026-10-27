// The cards the engine waits on, inline at the end of the transcript:
// · permission (S21, S23): "Allow Claude to run …?" — Deny (Esc) · Always allow (Ctrl+Shift+Enter),
//   with "Allow once" (Ctrl+Enter) under More allow options; writes and edits show their diff;
// · plan approval (S27): "Claude proposed a plan" — Reject · Revise… (Esc) · Accept
//   (Ctrl+Shift+Enter) · Accept and allow edits (Ctrl+Enter); the plan opens in the Plan pane;
// · question (S33): the options as choices plus Other — Skip · Submit (Ctrl+Enter).
// Their shortcuts work while the composer has focus.
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { structuredPatch } from "diff"
import { Icon } from "../icons"
import { MenuList, Popover } from "./popover"
import { answer, configure, showPlan, type Session } from "../store"
import { promptText } from "../tools"
import type { EngineMessage } from "../engine"

/** Card shortcuts, on the whole window while the card is up. */
function useKeys(handler: (e: KeyboardEvent) => boolean) {
  const onKey = (e: KeyboardEvent) => {
    if (handler(e)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  document.addEventListener("keydown", onKey, true)
  onCleanup(() => document.removeEventListener("keydown", onKey, true))
}

const ctrl = (e: KeyboardEvent) => e.ctrlKey || e.metaKey

export function RequestCard(props: { request: EngineMessage; session: Session }) {
  return (
    <Switch fallback={<PermissionCard request={props.request} />}>
      <Match when={props.request.params?.toolName === "ExitPlanMode"}>
        <PlanCard request={props.request} />
      </Match>
      <Match when={props.request.params?.toolName === "AskUserQuestion"}>
        <QuestionCard request={props.request} />
      </Match>
    </Switch>
  )
}

function WritePreview(props: { toolName: string; input: any }) {
  const lines = createMemo(() => {
    const i = props.input ?? {}
    const before = props.toolName === "Write" ? "" : String(i.old_string ?? "")
    const after = props.toolName === "Write" ? String(i.content ?? "") : String(i.new_string ?? "")
    const patch = structuredPatch("a", "b", before, after, "", "", { context: 2 })
    return patch.hunks.flatMap((h) => {
      let no = h.newStart
      return h.lines.filter((l) => !l.startsWith("\\")).map((l) => ({ kind: l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx", text: l.slice(1), no: l[0] === "-" ? null : no++ }))
    })
  })
  return (
    <div class="cc-preview" role="region" aria-label="Code">
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
    </div>
  )
}

function PermissionCard(props: { request: EngineMessage }) {
  const p = () => props.request.params ?? {}
  const id = () => String(props.request.id)
  const text = () => promptText(p().toolName, p().input, p().displayName, p().description)
  // "Always allow" uses the rule the engine suggests for this call, for this session.
  const rule = () =>
    (p().suggestions ?? [])
      .flatMap((s: any) => (s?.type === "addRules" && s.behavior === "allow" ? (s.rules ?? []) : []))
      .find((r: any) => r.toolName === p().toolName)?.ruleContent
  const deny = () => void answer(id(), { behavior: "deny" })
  const once = () => void answer(id(), { behavior: "allow" })
  const always = () => void answer(id(), { behavior: "allow", alwaysAllow: true, ...(rule() ? { ruleContent: rule() } : {}) })
  useKeys((e) => {
    if (e.key === "Escape") return (deny(), true)
    if (e.key === "Enter" && ctrl(e) && e.shiftKey) return (always(), true)
    if (e.key === "Enter" && ctrl(e)) return (once(), true)
    return false
  })
  const isWrite = () => ["Write", "Edit"].includes(p().toolName)
  return (
    <section class="cc-card-prompt" role="region" aria-label={`Permission request: ${text().verb}`}>
      <h3 class="cc-prompt-title">
        Allow Claude to {text().verb} {text().target}?
      </h3>
      <div class="cc-prompt-target">{text().target}</div>
      <Show when={text().detail}>
        <pre class="cc-prompt-detail">{text().detail}</pre>
      </Show>
      <Show when={isWrite()}>
        <WritePreview toolName={p().toolName} input={p().input} />
      </Show>
      <Show when={p().decisionReason && !/requested permissions/i.test(p().decisionReason)}>
        <p class="cc-muted cc-prompt-reason">{p().decisionReason}</p>
      </Show>
      <div class="cc-prompt-actions">
        <button class="cc-btn" aria-keyshortcuts="Escape" onClick={deny}>
          Deny
        </button>
        <div class="cc-split">
          <button class="cc-btn cc-primary" aria-label="Always allow , Applies to this session only" aria-keyshortcuts="Control+Shift+Enter" onClick={always}>
            Always allow <kbd>Ctrl</kbd>
            <kbd>Shift</kbd>
            <kbd>⏎</kbd>
          </button>
          <Popover
            placement="above"
            align="end"
            trigger={(_, toggle) => (
              <button class="cc-btn cc-primary cc-split-arrow" aria-label="More allow options" aria-haspopup="menu" onClick={toggle}>
                <Icon name="chevronDown" size={14} />
              </button>
            )}
          >
            {(close) => <MenuList close={close} items={[{ label: "Allow once", shortcut: "Ctrl+Enter", onSelect: once }]} />}
          </Popover>
        </div>
      </div>
      <p class="cc-sr">Always allow applies to this session only.</p>
    </section>
  )
}

function PlanCard(props: { request: EngineMessage }) {
  const [revising, setRevising] = createSignal(false)
  const [feedback, setFeedback] = createSignal("")
  const id = () => String(props.request.id)
  const plan = () => String(props.request.params?.plan ?? "")
  // The plan opens next to the transcript as soon as it's proposed, as in the original.
  onMount(() => showPlan(plan() || "The plan file couldn't be read."))
  const reject = () => void answer(id(), { behavior: "deny", message: "The user rejected this plan.", interrupt: true })
  const revise = () => void answer(id(), { behavior: "deny", message: feedback().trim() || "The user wants you to revise the plan." })
  const accept = async (mode: "default" | "acceptEdits") => {
    await answer(id(), { behavior: "allow" })
    await configure({ mode })
  }
  useKeys((e) => {
    if (revising()) {
      if (e.key === "Escape") return (setRevising(false), true)
      if (e.key === "Enter" && ctrl(e)) return (revise(), true)
      return false
    }
    if (e.key === "Escape") return (setRevising(true), true)
    if (e.key === "Enter" && ctrl(e) && e.shiftKey) return (void accept("default"), true)
    if (e.key === "Enter" && ctrl(e)) return (void accept("acceptEdits"), true)
    return false
  })
  return (
    <>
      <section class="cc-card-prompt cc-plan-card" role="region" aria-label="Plan approval">
        <div class="cc-plan-head">
          <h3 class="cc-prompt-title">Claude proposed a plan</h3>
          <div class="cc-grow" />
          <button class="cc-link-btn" onClick={() => showPlan(plan())}>
            Open plan
          </button>
        </div>
        <Show
          when={revising()}
          fallback={
            <div class="cc-prompt-actions cc-plan-actions">
              <button class="cc-btn" onClick={reject}>
                Reject
              </button>
              <button class="cc-btn" aria-keyshortcuts="Escape" onClick={() => setRevising(true)}>
                Revise… <kbd>Esc</kbd>
              </button>
              <button class="cc-btn" aria-keyshortcuts="Control+Shift+Enter" onClick={() => void accept("default")}>
                Accept <kbd>Ctrl</kbd>
                <kbd>Shift</kbd>
                <kbd>⏎</kbd>
              </button>
              <button class="cc-btn cc-primary" aria-keyshortcuts="Control+Enter" onClick={() => void accept("acceptEdits")}>
                Accept and allow edits <kbd>Ctrl</kbd>
                <kbd>⏎</kbd>
              </button>
            </div>
          }
        >
          <textarea
            class="cc-feedback"
            aria-label="Plan feedback"
            placeholder="What should change? (optional)"
            rows={3}
            value={feedback()}
            ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(e) => setFeedback(e.currentTarget.value)}
          />
          <div class="cc-prompt-actions">
            <button class="cc-btn" onClick={() => setRevising(false)}>
              Back
            </button>
            <button class="cc-btn cc-primary" onClick={revise}>
              Revise
            </button>
          </div>
        </Show>
      </section>
      <div class="cc-working">
        <span class="cc-dots" />
        <span>Proposing plan</span>
      </div>
    </>
  )
}

type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

function QuestionCard(props: { request: EngineMessage }) {
  const questions = (): Question[] => props.request.params?.input?.questions ?? []
  const [picked, setPicked] = createSignal<Record<string, string[]>>({})
  const [other, setOther] = createSignal<Record<string, string>>({})
  const id = () => String(props.request.id)
  const OTHER = "\u0000other"
  const toggle = (q: Question, label: string) =>
    setPicked((all) => {
      const now = all[q.question] ?? []
      const next = q.multiSelect ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label]
      return { ...all, [q.question]: next }
    })
  const ready = () => questions().every((q) => (picked()[q.question] ?? []).some((l) => l !== OTHER || (other()[q.question] ?? "").trim()))
  const submit = () => {
    if (!ready()) return
    const answers = Object.fromEntries(
      questions().map((q) => [q.question, (picked()[q.question] ?? []).map((l) => (l === OTHER ? other()[q.question]!.trim() : l)).join(", ")]),
    )
    void answer(id(), { behavior: "allow", answers })
  }
  const skip = () => void answer(id(), { behavior: "deny", message: "The user skipped the question." })
  useKeys((e) => {
    if (e.key === "Enter" && ctrl(e)) return (submit(), true)
    return false
  })
  return (
    <>
      <section class="cc-card-prompt cc-question" role="region" aria-label="Question">
        <For each={questions()}>
          {(q) => (
            <fieldset class="cc-q">
              <legend class="cc-q-title">{q.question}</legend>
              <For each={[...q.options.map((o) => ({ ...o, value: o.label })), { label: "Other", value: OTHER, description: undefined }]}>
                {(o) => {
                  const on = () => (picked()[q.question] ?? []).includes(o.value)
                  return (
                    <div class="cc-q-option" data-on={on() ? "" : undefined}>
                      <button role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on()} class="cc-q-pick" onClick={() => toggle(q, o.value)}>
                        <span class="cc-q-mark" data-multi={q.multiSelect ? "" : undefined} />
                        <span class="cc-q-text">
                          <span>{o.label}</span>
                          <Show when={o.description}>
                            <span class="cc-muted">{o.description}</span>
                          </Show>
                        </span>
                      </button>
                      <Show when={o.value === OTHER && on()}>
                        <input
                          class="cc-q-other"
                          aria-label={`Other answer for ${q.question}`}
                          value={other()[q.question] ?? ""}
                          ref={(el) => queueMicrotask(() => el.focus())}
                          onInput={(e) => setOther((all) => ({ ...all, [q.question]: e.currentTarget.value }))}
                        />
                      </Show>
                    </div>
                  )
                }}
              </For>
            </fieldset>
          )}
        </For>
        <div class="cc-prompt-actions">
          <button class="cc-btn" onClick={skip}>
            Skip
          </button>
          <button class="cc-btn cc-primary" aria-keyshortcuts="Control+Enter" disabled={!ready()} onClick={submit}>
            Submit <kbd>Ctrl</kbd>
            <kbd>⏎</kbd>
          </button>
        </div>
      </section>
      <div class="cc-working">
        <span class="cc-q-dot" />
        <span class="cc-badge-attention">Needs your input</span>
      </div>
    </>
  )
}
