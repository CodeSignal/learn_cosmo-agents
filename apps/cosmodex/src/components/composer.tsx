// The composer: project chip (home), input, "+" menu, permissions menu, model and effort popover,
// and Send / Stop / Resume. An open approval for the thread replaces it (see ApprovalCard).
import { createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "../icons"
import { MenuList, Popover } from "./popover"
import { chooseModel, PROJECT, send, setPlanMode, showToast, state, stop, type ThreadView } from "../store"
import { prefs } from "../prefs"

const LOCKED = "Disabled for this task"

function effortLabel(effort: string | null) {
  if (!effort) return ""
  const names: Record<string, string> = { none: "None", minimal: "Minimal", low: "Light", medium: "Medium", high: "High", xhigh: "Extra High" }
  return names[effort] ?? effort[0]!.toUpperCase() + effort.slice(1)
}

function modelLabel(model: string | null) {
  const found = state.models.find((m) => m.model === model)
  return found?.displayName ?? model ?? "Model"
}

function PermissionsMenu() {
  return (
    <Popover
      placement="above"
      trigger={(_, toggle) => (
        <button class="cx-chip" aria-label="Change permissions" onClick={toggle}>
          <Icon name="hand" size={14} /> Ask for approval
        </button>
      )}
    >
      {(close) => (
        <div class="cx-perm-menu">
          <div class="cx-perm-head">How should Cosmodex actions be approved?</div>
          <MenuList
            close={close}
            items={[
              { label: "Ask for approval", subtitle: "Always ask to edit external files and use the internet", checked: true },
              { label: "Approve for me", locked: LOCKED },
              { label: "Full access", locked: LOCKED },
            ]}
          />
        </div>
      )}
    </Popover>
  )
}

function ModelPopover() {
  const current = createMemo(() => state.models.find((m) => m.model === state.model))
  return (
    <Popover
      placement="above"
      align="end"
      class="cx-model-popover"
      trigger={(open, toggle) => (
        <button class="cx-chip" aria-label="Model and effort" onClick={toggle}>
          {open() ? "Select effort" : `${modelLabel(state.model)} ${effortLabel(state.effort)}`} <Icon name="chevronDown" size={12} />
        </button>
      )}
    >
      {(close) => (
        <div class="cx-model-card">
          <div class="cx-model-effort">{effortLabel(state.effort)}</div>
          <div class="cx-model-name">{modelLabel(state.model)}</div>
          <div class="cx-effort-steps" role="radiogroup" aria-label="Power">
            <For each={current()?.supportedReasoningEfforts ?? []}>
              {(option) => (
                <button
                  role="radio"
                  aria-checked={state.effort === option.reasoningEffort}
                  title={option.description}
                  class="cx-effort-step"
                  onClick={() => chooseModel(state.model!, option.reasoningEffort)}
                >
                  {effortLabel(option.reasoningEffort)}
                </button>
              )}
            </For>
          </div>
          <div class="cx-menu-heading">Models</div>
          <MenuList
            close={close}
            items={state.models.map((m) => ({
              label: m.displayName,
              subtitle: m.description,
              checked: m.model === state.model,
              onSelect: () => chooseModel(m.model, m.defaultReasoningEffort),
            }))}
          />
        </div>
      )}
    </Popover>
  )
}

export function Composer(props: { thread?: ThreadView }) {
  const [text, setText] = createSignal("")
  const running = () => props.thread?.loaded?.at(-1)?.status === "inProgress"
  const stopped = () => props.thread?.loaded?.at(-1)?.status === "interrupted"
  // While a turn runs, sending follows the Follow-up behaviour setting (queue or steer).
  const submit = () => {
    const value = text().trim()
    if (!value) return
    setText("")
    void send(value)
  }
  const queued = () => (props.thread ? (state.queued[props.thread.id]?.length ?? 0) : 0)
  return (
    <div class="cx-composer">
      <Show when={!props.thread}>
        <div class="cx-project-chip">
          <Icon name="folder" size={14} /> {PROJECT} <Icon name="chevronDown" size={12} />
        </div>
      </Show>
      <textarea
        class="cx-input"
        rows={2}
        placeholder={state.planMode ? "Describe your task to generate a plan..." : props.thread ? "Work with Cosmodex" : "Do anything"}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.isComposing) return
          const withCtrl = e.ctrlKey || e.metaKey
          if (prefs.sendShortcut === "Enter" ? !withCtrl : withCtrl) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div class="cx-composer-row">
        <Popover
          placement="above"
          trigger={(_, toggle) => (
            <button class="cx-icon-btn" aria-label="Add files and more" onClick={toggle}>
              <Icon name="plus" />
            </button>
          )}
        >
          {(close) => (
            <MenuList
              close={close}
              items={[
                { heading: "Add" },
                { label: "Files and folders", onSelect: () => showToast("This part of Cosmodex isn't available yet.") },
                {
                  label: "Plan mode",
                  subtitle: state.planMode ? "Turn plan mode off" : "Turn plan mode on",
                  checked: state.planMode,
                  onSelect: () => setPlanMode(!state.planMode),
                },
              ]}
            />
          )}
        </Popover>
        <PermissionsMenu />
        <Show when={state.planMode}>
          <button class="cx-chip cx-chip-on" aria-label="Plan mode on; turn off" onClick={() => setPlanMode(false)}>
            <Icon name="bulb" size={14} /> Plan
          </button>
        </Show>
        <div class="cx-grow" />
        <ModelPopover />
        <Show when={queued()}>
          <span class="cx-menu-subtitle">{queued()} queued</span>
        </Show>
        <Show
          when={running() && !text().trim()}
          fallback={
            <button class="cx-send" aria-label={stopped() && !text() ? "Resume" : "Send"} disabled={!text().trim() && !stopped()} onClick={() => (stopped() && !text().trim() ? void send("Continue") : submit())}>
              <Icon name={stopped() && !text().trim() ? "resume" : "send"} />
            </button>
          }
        >
          <button class="cx-send" aria-label="Stop" onClick={() => void stop(props.thread!.id, props.thread!.loaded!.at(-1)!.id)}>
            <Icon name="stop" />
          </button>
        </Show>
      </div>
    </div>
  )
}
