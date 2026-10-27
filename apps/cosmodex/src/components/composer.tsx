// The composer: project chip (home), input, "+" menu, permissions menu, model and effort popover,
// and Send / Stop / Resume. An open approval for the thread replaces it (see ApprovalCard).
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { Icon } from "../icons"
import { MenuList, Popover } from "./popover"
import { chooseModel, effortLabel, modelName, PROJECT, send, setPlanMode, state, stop, type ThreadView } from "../store"
import { editor } from "../editor"
import { PromptInput } from "./prompt-input"

const LOCKED = "Disabled for this task"

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
          {open() ? "Select effort" : `${modelName(state.model)} ${effortLabel(state.effort)}`} <Icon name="chevronDown" size={12} />
        </button>
      )}
    >
      {(close) => (
        <div class="cx-model-card">
          <div class="cx-model-effort">{effortLabel(state.effort)}</div>
          <div class="cx-model-name">{modelName(state.model)}</div>
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

const PROJECT_LOCKED = "Not available in this task"

/** "Change project" (S23): a search box, the task's one project (checked), then New project and
 * Don't work in a project, which a task can't offer. */
export function ProjectPopover(props: { trigger: (toggle: () => void) => JSX.Element; placement?: "above" | "below" }) {
  const [query, setQuery] = createSignal("")
  return (
    <Popover placement={props.placement ?? "above"} class="cx-project-popover" trigger={(_, toggle) => props.trigger(toggle)}>
      {(close) => (
        <div role="dialog" aria-label="Change project">
          <label class="cx-project-search">
            <Icon name="search" size={14} />
            <input
              placeholder="Search projects"
              role="combobox"
              aria-expanded="true"
              value={query()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && close()}
            />
          </label>
          <ul class="cx-menu" role="listbox" aria-label="Suggestions">
            <Show when={PROJECT.toLowerCase().includes(query().trim().toLowerCase())} fallback={<li class="cx-empty-row">No projects</li>}>
              <li>
                <button class="cx-menu-item" role="option" aria-selected="true" onClick={close}>
                  <Icon name="folder" size={14} />
                  <span class="cx-menu-text">
                    <span class="cx-menu-label">{PROJECT}</span>
                  </span>
                  <Icon name="check" size={14} />
                </button>
              </li>
            </Show>
            <li class="cx-menu-sep" role="separator" />
            <For each={[{ icon: "plus" as const, label: "New project" }, { icon: "close" as const, label: "Don't work in a project" }]}>
              {(item) => (
                <li>
                  <button class="cx-menu-item" role="option" disabled data-locked="" title={PROJECT_LOCKED}>
                    <Icon name={item.icon} size={14} />
                    <span class="cx-menu-text">
                      <span class="cx-menu-label">{item.label}</span>
                      <span class="cx-menu-subtitle">{PROJECT_LOCKED}</span>
                    </span>
                    <Icon name="lock" size={14} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      )}
    </Popover>
  )
}

export function Composer(props: { thread?: ThreadView }) {
  const [empty, setEmpty] = createSignal(true)
  let submit = () => {}
  const running = () => props.thread?.loaded?.at(-1)?.status === "inProgress"
  const stopped = () => props.thread?.loaded?.at(-1)?.status === "interrupted"
  // While a turn runs, sending follows the Follow-up behaviour setting (queue or steer).
  const queued = () => (props.thread ? (state.queued[props.thread.id]?.length ?? 0) : 0)
  return (
    <div class="cx-composer">
      <Show when={!props.thread}>
        <ProjectPopover
          trigger={(toggle) => (
            <button class="cx-project-chip" aria-label={`Change project: ${PROJECT}`} onClick={toggle}>
              <Icon name="folder" size={14} /> {PROJECT} <Icon name="chevronDown" size={12} />
            </button>
          )}
        />
      </Show>
      <PromptInput
        placeholder={state.planMode ? "Describe your task to generate a plan..." : props.thread ? "Work with Cosmodex" : "Do anything"}
        onEmptyChange={setEmpty}
        submitRef={(fn) => (submit = fn)}
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
                { label: "Files and folders", onSelect: () => editor.browseFiles() },
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
          when={running() && empty()}
          fallback={
            <button class="cx-send" aria-label={stopped() && empty() ? "Resume" : "Send"} disabled={empty() && !stopped()} onClick={() => (stopped() && empty() ? void send("Continue") : submit())}>
              <Icon name={stopped() && empty() ? "resume" : "send"} />
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
