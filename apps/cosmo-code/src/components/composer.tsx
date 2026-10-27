// The composer: prompt box ("+" Add, the prompt, send / stop) and the prompt bar under it. A new
// session's bar shows Environment, Folder, mode, model and usage; inside a session just mode,
// model and usage. Enter sends; while Claude works, Ctrl+Enter queues for later and Esc stops.
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "../icons"
import { MenuList, Popover } from "./popover"
import { soon } from "./chrome"
import {
  activeSession,
  configure,
  currentSettings,
  FOLDER,
  interrupt,
  queue,
  requestFor,
  send,
  state,
  WORKSPACE,
  type Effort,
  type Mode,
} from "../store"

const LOCKED = "Not available in this task"

export const MODES: { id: Mode; label: string; description: string; key: string }[] = [
  { id: "default", label: "Manual", description: "Always ask before making changes", key: "1" },
  { id: "acceptEdits", label: "Accept edits", description: "Automatically accept all file edits", key: "2" },
  { id: "plan", label: "Plan", description: "Create a plan before making changes", key: "3" },
]

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra" },
  { id: "max", label: "Max" },
]

const FAMILY: Record<string, string> = {
  sonnet: "Most efficient for everyday tasks",
  haiku: "Fastest for quick answers",
  opus: "Most capable for complex work",
}

/** "claude-sonnet-5-5" → "Sonnet 5.5". */
export function modelName(id: string | null | undefined) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id ?? "")
  if (!m) return id ?? "Model"
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`
}

/** The task's models as the engine offers them, one entry per actual model. */
function models() {
  const seen = new Map<string, { id: string; isDefault: boolean; family: string }>()
  for (const m of state.info?.models ?? []) {
    const id = m.resolvedModel ?? m.value
    if (!/^claude-/.test(id)) continue
    const entry = seen.get(id) ?? { id, isDefault: false, family: /^claude-([a-z]+)/.exec(id)?.[1] ?? "" }
    if (m.value === "default") entry.isDefault = true
    seen.set(id, entry)
  }
  return [...seen.values()]
}

/** The model the session runs (an alias like "default" resolves to the actual model). */
function currentModel() {
  const value = currentSettings().model
  const info = state.info?.models.find((m) => m.value === value)
  return info?.resolvedModel ?? value ?? models()[0]?.id ?? null
}

function ModeMenu() {
  const mode = () => currentSettings().mode
  const label = () => MODES.find((m) => m.id === mode())?.label ?? "Manual"
  return (
    <Popover
      placement="above"
      class="cc-mode-menu"
      trigger={(_, toggle) => (
        <button class="cc-bar-btn" aria-label={activeSession() ? label() : `Permissions: ${label()}`} aria-keyshortcuts="Control+Shift+M" data-menu="mode" onClick={toggle}>
          {label()}
        </button>
      )}
    >
      {(close) => (
        <MenuList
          close={close}
          items={[
            ...MODES.map((m) => ({ label: m.label, subtitle: m.description, shortcut: m.key, checked: mode() === m.id, onSelect: () => void configure({ mode: m.id }) })),
            { label: "Bypass permissions", subtitle: "Disabled by your organization", disabled: true },
          ]}
        />
      )}
    </Popover>
  )
}

function ModelMenu() {
  const [effortOpen, setEffortOpen] = createSignal(false)
  const effort = () => currentSettings().effort
  const effortLabel = () => EFFORTS.find((e) => e.id === effort())?.label ?? "Medium"
  return (
    <Popover
      placement="above"
      align="end"
      class="cc-model-menu"
      trigger={(_, toggle) => (
        <button
          class="cc-bar-btn"
          aria-label={`Model: ${modelName(currentModel())} ${effortLabel()}`}
          aria-keyshortcuts="Control+Shift+I"
          data-menu="model"
          onClick={() => (setEffortOpen(false), toggle())}
        >
          {modelName(currentModel())} <span class="cc-muted">{effortLabel()}</span>
        </button>
      )}
    >
      {(close) => (
        <div class="cc-model-panel">
          <Show when={effortOpen()}>
            <div class="cc-effort" role="menu" aria-label="Effort">
              <p class="cc-menu-note">Higher effort means more thorough responses, but takes longer and uses your limits faster.</p>
              <MenuList
                close={close}
                items={EFFORTS.map((e) => ({
                  label: e.id === "medium" ? "Medium · Recommended" : e.label,
                  checked: effort() === e.id,
                  onSelect: () => void configure({ effort: e.id }),
                }))}
              />
            </div>
          </Show>
          <div class="cc-model-list">
            <div class="cc-menu-heading">Model · this session</div>
            <MenuList
              close={close}
              items={models().map((m, i) => ({
                label: `${modelName(m.id)}${m.isDefault ? " · Default" : ""}`,
                subtitle: FAMILY[m.family],
                shortcut: String(i + 1),
                checked: currentModel() === m.id,
                onSelect: () => void configure({ model: m.id }),
              }))}
            />
            <div class="cc-menu-sep" role="separator" />
            <button class="cc-menu-item" role="menuitem" aria-haspopup="menu" aria-expanded={effortOpen()} aria-keyshortcuts="Control+Shift+E" onClick={() => setEffortOpen((v) => !v)}>
              <span class="cc-menu-text">
                <span class="cc-menu-label">Effort</span>
              </span>
              <span class="cc-muted">{effortLabel()}</span>
              <Icon name="chevronRight" size={13} />
            </button>
          </div>
        </div>
      )}
    </Popover>
  )
}

function Usage() {
  const s = () => activeSession()
  const label = () => {
    const c = s()?.context
    if (!c) return "Context 0"
    const k = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    return `Context ${k(c.totalTokens)} / ${k(c.maxTokens)} (${Math.round(c.percentage)}%)`
  }
  return (
    <Popover
      placement="above"
      align="end"
      trigger={(_, toggle) => (
        <button class="cc-icon-btn cc-ring" aria-label={`Usage: ${label()}`} aria-haspopup="dialog" onClick={toggle}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="2" />
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray={`${((s()?.context?.percentage ?? 0) / 100) * 56.5} 56.5`} transform="rotate(-90 12 12)" />
          </svg>
        </button>
      )}
    >
      {() => (
        <div class="cc-usage" role="dialog" aria-label="Usage">
          <h2 class="cc-usage-title">Usage</h2>
          <div class="cc-usage-row">
            <span>Context window</span>
            <span class="cc-muted">{label().replace(/^Context /, "")}</span>
          </div>
        </div>
      )}
    </Popover>
  )
}

export function Composer() {
  const [text, setText] = createSignal("")
  let input!: HTMLTextAreaElement
  const session = () => activeSession()
  const working = () => session()?.state === "running"
  const waiting = () => (session() ? !!requestFor(session()!.id) : false)
  const placeholder = createMemo(() => {
    if (!session()) return "Describe a task or ask a question"
    return working() ? "Enter to send, Ctrl+Enter to queue for later" : "Type / for commands"
  })
  const submit = (later: boolean) => {
    const value = text().trim()
    if (!value) return
    setText("")
    input.style.height = "auto"
    if (later) queue(value)
    else void send(value)
  }
  // Esc stops Claude, unless a card (permission, plan, question) is waiting: then it's the card's.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && working() && !waiting() && !e.defaultPrevented) {
      e.preventDefault()
      void interrupt()
    }
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))
  const queued = () => (session() ? (state.queued[session()!.id]?.length ?? 0) : 0)
  return (
    <div class="cc-composer">
      <div class="cc-prompt-box">
        <Popover
          placement="above"
          trigger={(_, toggle) => (
            <button class="cc-icon-btn" aria-label="Add" aria-haspopup="menu" onClick={toggle}>
              <Icon name="plus" size={17} />
            </button>
          )}
        >
          {(close) => (
            <MenuList
              close={close}
              items={[
                { label: "Add files or photos", shortcut: "Ctrl+U", onSelect: soon },
                { label: "Add folder", locked: LOCKED },
                { label: "Import GitHub issue", subtitle: "This folder doesn't have a GitHub remote", disabled: true },
                { separator: true },
                { label: "Slash commands", onSelect: () => (setText("/"), input.focus()) },
                { label: "Manage connectors", locked: LOCKED },
                { label: "Add plugins", locked: LOCKED },
              ]}
            />
          )}
        </Popover>
        <textarea
          ref={input}
          class="cc-prompt"
          aria-label="Prompt"
          aria-description={placeholder()}
          rows={1}
          placeholder={placeholder()}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value)
            e.currentTarget.style.height = "auto"
            e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 240)}px`
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.isComposing) return
            e.preventDefault()
            submit((e.ctrlKey || e.metaKey) && working())
          }}
        />
        <Show
          when={working() && !text().trim()}
          fallback={
            <button class="cc-send" aria-label="Send" disabled={!text().trim()} onClick={() => submit(false)}>
              <Icon name="send" size={15} />
            </button>
          }
        >
          <button class="cc-icon-btn cc-stop" aria-label="Stop" aria-keyshortcuts="Escape" onClick={() => void interrupt()}>
            <Icon name="stop" size={18} />
          </button>
        </Show>
      </div>
      <div class="cc-prompt-bar">
        <Show when={!session()}>
          <Popover
            placement="above"
            trigger={(_, toggle) => (
              <button class="cc-bar-btn" aria-label="Environment: This computer" onClick={toggle}>
                <Icon name="laptop" size={14} /> This computer
              </button>
            )}
          >
            {(close) => (
              <MenuList
                close={close}
                items={[
                  { label: "This computer", shortcut: "Alt+1", checked: true },
                  { label: "New environment", shortcut: "Alt+0", locked: LOCKED },
                ]}
              />
            )}
          </Popover>
          <Popover
            placement="above"
            trigger={(_, toggle) => (
              <button class="cc-bar-btn" aria-label={`Folder: ${WORKSPACE}`} aria-description={WORKSPACE} onClick={toggle}>
                <Icon name="folder" size={14} /> {FOLDER}
              </button>
            )}
          >
            {(close) => (
              <MenuList
                close={close}
                items={[
                  { label: FOLDER, subtitle: WORKSPACE, checked: true },
                  { separator: true },
                  { label: "Open folder…", locked: LOCKED },
                ]}
              />
            )}
          </Popover>
        </Show>
        <ModeMenu />
        <div class="cc-grow" />
        <Show when={queued()}>
          <span class="cc-muted">{queued()} queued</span>
        </Show>
        <ModelMenu />
        <Usage />
      </div>
    </div>
  )
}
