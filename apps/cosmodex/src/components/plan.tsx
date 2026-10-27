// Plan mode: the question card (replaces the composer while the agent asks), the plan card
// (Plan header, Copy, Download plan, rendered plan), and "Implement this plan?" (replaces the
// composer after a plan until answered).
import { createSignal, For, Index, Show } from "solid-js"
import { RichMarkdown } from "./rich-markdown"
import { Icon } from "../icons"
import { answerPlan, answerQuestions, showToast } from "../store"
import type { EngineMessage } from "../engine"
import type { ToolRequestUserInputQuestion } from "../protocol/v2/ToolRequestUserInputQuestion"

const RECOMMENDED = /\s*\(Recommended\)\s*$/i

/** The text between the <proposed_plan> tags, if the reply carries one. */
export function proposedPlan(text: string) {
  const m = /<proposed_plan>\s*\n([\s\S]*?)\n\s*<\/proposed_plan>/.exec(text)
  return m ? m[1]!.trim() : null
}

/** A reply with the plan block taken out (the plan card shows it). */
export function withoutPlan(text: string) {
  return text.replace(/<proposed_plan>[\s\S]*?<\/proposed_plan>/, "").trim()
}

export function PlanCard(props: { plan: string }) {
  const title = () => /^#\s+(.+)$/m.exec(props.plan)?.[1] ?? "Plan"
  const download = () => {
    const url = URL.createObjectURL(new Blob([props.plan + "\n"], { type: "text/markdown" }))
    const a = Object.assign(document.createElement("a"), { href: url, download: `${title().toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md` })
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <section class="cx-plan">
      <header class="cx-plan-head">
        <Icon name="bulb" size={14} /> Plan
        <div class="cx-grow" />
        <button class="cx-icon-btn cx-small" aria-label="Download plan" title="Download plan" onClick={download}>
          <Icon name="download" size={14} />
        </button>
        <button
          class="cx-icon-btn cx-small"
          aria-label="Copy"
          title="Copy"
          onClick={() => void navigator.clipboard.writeText(props.plan).then(() => showToast("Plan copied"))}
        >
          <Icon name="copy" size={14} />
        </button>
      </header>
      <RichMarkdown class="cx-plan-body" text={props.plan} />
    </section>
  )
}

function Question(props: { q: ToolRequestUserInputQuestion; index: number; onAnswer: (a: string[]) => void; onDismiss: () => void }) {
  const [other, setOther] = createSignal("")
  return (
    <div class="cx-question">
      <div class="cx-question-head">
        <span class="cx-question-title">{props.q.question}</span>
        <div class="cx-grow" />
        <button class="cx-icon-btn cx-small" aria-label="Dismiss" onClick={props.onDismiss}>
          ×
        </button>
      </div>
      <ol class="cx-options">
        <Index each={props.q.options ?? []}>
          {(option, i) => (
            <li>
              <button class="cx-option" onClick={() => props.onAnswer([option().label])}>
                <span class="cx-option-no">{i + 1}.</span>
                <span class="cx-option-text">
                  <span class="cx-option-label">
                    {option().label.replace(RECOMMENDED, "")}
                    <Show when={RECOMMENDED.test(option().label)}>
                      <span class="cx-tag">Recommended</span>
                    </Show>
                  </span>
                  <span class="cx-menu-subtitle">{option().description}</span>
                </span>
                <span aria-hidden="true">→</span>
              </button>
            </li>
          )}
        </Index>
      </ol>
      <form
        class="cx-other"
        onSubmit={(e) => {
          e.preventDefault()
          if (other().trim()) props.onAnswer([other().trim()])
        }}
      >
        <input
          class="cx-other-input"
          type={props.q.isSecret ? "password" : "text"}
          placeholder="No, and tell Cosmodex what to do differently"
          value={other()}
          onInput={(e) => setOther(e.currentTarget.value)}
        />
      </form>
    </div>
  )
}

/** The engine's questions, one at a time; all answers go back together. */
export function QuestionCard(props: { request: EngineMessage }) {
  const questions = (): ToolRequestUserInputQuestion[] => props.request.params?.questions ?? []
  const [step, setStep] = createSignal(0)
  const answers: Record<string, string[]> = {}
  const submit = () => void answerQuestions(String(props.request.id), answers)
  const answer = (q: ToolRequestUserInputQuestion, a: string[]) => {
    answers[q.id] = a
    if (step() + 1 < questions().length) setStep(step() + 1)
    else submit()
  }
  return (
    <div class="cx-approval" role="dialog" aria-label="Question">
      <For each={questions()}>
        {(q, i) => (
          <Show when={i() === step()}>
            <Question q={q} index={i()} onAnswer={(a) => answer(q, a)} onDismiss={submit} />
          </Show>
        )}
      </For>
      <div class="cx-approval-actions">
        <span class="cx-menu-subtitle">
          {step() + 1} of {questions().length}
        </span>
        <div class="cx-grow" />
        <button class="cx-btn" onClick={() => (step() + 1 < questions().length ? setStep(step() + 1) : submit())}>
          Skip
        </button>
      </div>
    </div>
  )
}

export function ImplementPrompt(props: { turnId: string }) {
  const [feedback, setFeedback] = createSignal("")
  return (
    <div class="cx-approval" role="dialog" aria-label="Implement this plan?">
      <div class="cx-question-title">Implement this plan?</div>
      <ol class="cx-options">
        <li>
          <button class="cx-option" onClick={() => void answerPlan(props.turnId, { implement: true })}>
            <span class="cx-option-no">1.</span>
            <span class="cx-option-label">Yes, implement this plan</span>
            <Icon name="check" size={14} />
          </button>
        </li>
      </ol>
      <form
        class="cx-other"
        onSubmit={(e) => {
          e.preventDefault()
          if (feedback().trim()) void answerPlan(props.turnId, { feedback: feedback().trim() })
        }}
      >
        <input
          class="cx-other-input"
          placeholder="No, and tell Cosmodex what to do differently"
          value={feedback()}
          onInput={(e) => setFeedback(e.currentTarget.value)}
        />
      </form>
      <div class="cx-approval-actions">
        <button class="cx-btn" onClick={() => void answerPlan(props.turnId, { skip: true })}>
          Skip
        </button>
      </div>
    </div>
  )
}
