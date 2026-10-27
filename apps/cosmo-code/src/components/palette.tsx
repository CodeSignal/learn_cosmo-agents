// The command palette (S16, Ctrl+K): "Search or start a chat" — Quick actions (New session),
// Recents (sessions, by when), Actions — and Tab switches to "Search actions" (navigation,
// session, settings and customize actions). Arrows move, Enter runs, Esc closes. Typing a
// prompt and choosing New session starts a session with it.
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Icon, type IconName } from "../icons"
import { soon } from "./chrome"
import { closePalette, newSession, openPalette, openSession, send, sessionOrder, state, toggleSidebar } from "../store"

const LOCKED = "Not available in this task"

type Entry = { key: string; icon: IconName; label: string; hint?: string; keys?: string[]; locked?: string; run: () => void }
type Section = { title: string; entries: Entry[] }

function when(ms: number) {
  const age = Date.now() - ms
  if (age < 3_600_000) return "Past hour"
  if (age < 86_400_000) return "Today"
  if (age < 2 * 86_400_000) return "Yesterday"
  if (age < 7 * 86_400_000) return "Past week"
  return "Older"
}

const focus = (selector: string) => queueMicrotask(() => (document.querySelector(selector) as HTMLElement | null)?.focus())

const ACTIONS: Section[] = [
  { title: "Navigation", entries: [{ key: "code", icon: "code", label: "Code", run: () => {} }] },
  {
    title: "Session",
    entries: [
      { key: "import", icon: "terminal", label: "Import CLI sessions", locked: LOCKED, run: () => {} },
      { key: "terminal", icon: "terminal", label: "Show terminal", keys: ["Ctrl", "`"], run: soon },
      { key: "files", icon: "folder", label: "Show files", keys: ["Ctrl", "Shift", "F"], run: soon },
    ],
  },
  {
    title: "Settings",
    entries: [
      ...["General", "Privacy", "Usage", "Cosmo Code"].map((page): Entry => ({ key: `s-${page}`, icon: "gear", label: `Settings → ${page}`, run: soon })),
      { key: "s-cowork", icon: "gear", label: "Settings → Cowork", locked: LOCKED, run: () => {} },
      { key: "s-import", icon: "gear", label: "Settings → Import & export", locked: LOCKED, run: () => {} },
      { key: "s-system", icon: "gear", label: "Settings → This computer → System", run: soon },
    ],
  },
  {
    title: "Customize",
    entries: ["Skills", "Connectors", "Plugins"].map((page): Entry => ({ key: `c-${page}`, icon: "briefcase", label: `Customize → ${page}`, run: soon })),
  },
  {
    title: "General",
    entries: [
      { key: "sidebar", icon: "sidebar", label: "Toggle sidebar", keys: ["Ctrl", "B"], run: toggleSidebar },
      { key: "shortcuts", icon: "keyboard", label: "Keyboard shortcuts", keys: ["Ctrl", "/"], run: soon },
      { key: "nav", icon: "sidebar", label: "Jump to navigation", run: () => focus(".cc-sidebar button") },
      { key: "main", icon: "code", label: "Jump to main content", run: () => focus(".cc-scroll") },
      { key: "input", icon: "comment", label: "Jump to input", run: () => focus(".cc-prompt") },
    ],
  },
]

export function Palette() {
  return <Show when={state.palette}>{(mode) => <Dialog mode={mode()} />}</Show>
}

function Dialog(props: { mode: "recents" | "actions" }) {
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  let input!: HTMLInputElement
  queueMicrotask(() => input?.focus())

  const sections = createMemo((): Section[] => {
    const q = query().trim().toLowerCase()
    const match = (e: Entry) => !q || e.label.toLowerCase().includes(q)
    if (props.mode === "actions") return ACTIONS.map((s) => ({ ...s, entries: s.entries.filter(match) })).filter((s) => s.entries.length)
    const prompt = query().trim()
    const start: Entry = {
      key: "new",
      icon: "code",
      label: prompt ? `New session: ${prompt}` : "New session",
      run: () => {
        newSession()
        if (prompt) void send(prompt)
      },
    }
    return [
      { title: "Quick actions", entries: [start] },
      {
        title: "Recents",
        entries: sessionOrder()
          .filter((s) => !q || s.title.toLowerCase().includes(q))
          .slice(0, 8)
          .map((s): Entry => ({ key: s.id, icon: "code", label: s.title, hint: when(s.lastModified), run: () => void openSession(s.id) })),
      },
      { title: "Actions", entries: ACTIONS[0]!.entries.filter(match) },
    ].filter((s) => s.entries.length)
  })
  const entries = createMemo(() => sections().flatMap((s) => s.entries))
  createEffect(on([() => props.mode, query], () => setActive(0)))

  const run = (entry: Entry | undefined) => {
    if (!entry || entry.locked) return
    closePalette()
    entry.run()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const n = entries().length
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      closePalette()
    } else if (e.key === "Tab") {
      e.preventDefault()
      openPalette(props.mode === "recents" ? "actions" : "recents")
      setQuery("")
      input.focus()
    } else if (e.key === "ArrowDown" && n) {
      e.preventDefault()
      setActive((i) => (i + 1) % n)
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault()
      setActive((i) => (i - 1 + n) % n)
    } else if (e.key === "Enter") {
      e.preventDefault()
      run(entries()[active()])
    }
  }

  return (
    <div class="cc-scrim" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div class="cc-palette" role="dialog" aria-label="Search" onKeyDown={onKeyDown}>
        <h2 class="cc-sr">Search</h2>
        <div class="cc-palette-head">
          <Show when={props.mode === "actions"}>
            <span class="cc-palette-chip">
              <Icon name="keyboard" size={14} />
              <button class="cc-icon-btn cc-small" aria-label="Back to search" onClick={() => (openPalette("recents"), input.focus())}>
                <Icon name="close" size={12} />
              </button>
            </span>
          </Show>
          <input
            ref={input}
            class="cc-palette-input"
            role="combobox"
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-label={props.mode === "actions" ? "Search actions" : "Search or start a chat"}
            placeholder={props.mode === "actions" ? "Search actions" : "Search or start a chat"}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button class="cc-icon-btn" aria-label="Close" onClick={closePalette}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div class="cc-palette-list" role="listbox">
          <For each={sections()}>
            {(section) => (
              <>
                <div class="cc-palette-heading">
                  {section.title}
                  <Show when={props.mode === "recents" && section.title !== "Quick actions"}>
                    <Icon name="chevronRight" size={12} />
                  </Show>
                </div>
                <For each={section.entries}>
                  {(entry) => {
                    const i = () => entries().indexOf(entry)
                    return (
                      <button
                        role="option"
                        class="cc-palette-row"
                        aria-selected={active() === i()}
                        data-locked={entry.locked ? "" : undefined}
                        aria-disabled={!!entry.locked}
                        title={entry.locked}
                        ref={(el) => createEffect(() => active() === i() && el.scrollIntoView({ block: "nearest" }))}
                        onMouseMove={() => setActive(i())}
                        onClick={() => run(entry)}
                      >
                        <Icon name={entry.icon} size={15} />
                        <span class="cc-palette-label">{entry.label}</span>
                        <Show when={entry.locked}>
                          <span class="cc-lock-note">
                            <Icon name="lock" size={12} /> {entry.locked}
                          </span>
                        </Show>
                        <div class="cc-grow" />
                        <Show when={entry.hint}>
                          <span class="cc-muted cc-palette-hint">{entry.hint}</span>
                        </Show>
                        <For each={entry.keys ?? []}>{(k) => <kbd class="cc-key">{k}</kbd>}</For>
                        <Show when={active() === i() && !entry.keys && !entry.locked}>
                          <span class="cc-muted">↵</span>
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </div>
        <footer class="cc-palette-foot">
          <span>Select</span> <kbd class="cc-key">↑</kbd>
          <kbd class="cc-key">↓</kbd>
          <span>{props.mode === "recents" ? "Actions" : "Search"}</span> <kbd class="cc-key">Tab</kbd>
          <span>Open menu</span> <kbd class="cc-key">Ctrl</kbd>
          <kbd class="cc-key">K</kbd>
        </footer>
      </div>
    </div>
  )
}
