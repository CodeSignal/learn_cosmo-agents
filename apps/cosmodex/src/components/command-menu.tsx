// The command menu (sidebar Search, Ctrl+P for Files): a centred dialog with tabs All · Actions ·
// Chats · Files · Text (Tab cycles them), a search box, and a list of suggestions. Arrow keys move,
// Enter runs, Esc closes. Files come from the engine's fuzzy search in the workspace; Text searches
// what was said in the chats.
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Icon, type IconName } from "../icons"
import { ACTIONS, type Action } from "../actions"
import { call } from "../engine"
import {
  closeCommandMenu,
  loadTurns,
  openCommandMenu,
  openFile,
  openThread,
  PROJECT,
  state,
  threadOrder,
  threadTitle,
  WORKSPACE,
  type CommandTab,
} from "../store"
import type { FuzzyFileSearchResponse } from "../protocol/FuzzyFileSearchResponse"

const TABS: { id: CommandTab; label: string; placeholder: string }[] = [
  { id: "all", label: "All", placeholder: "Search Cosmodex" },
  { id: "actions", label: "Actions", placeholder: "Search actions" },
  { id: "chats", label: "Chats", placeholder: "Search chats" },
  { id: "files", label: "Files", placeholder: "Search files" },
  { id: "text", label: "Text", placeholder: "Search chat text" },
]

type Entry = { key: string; icon: IconName; label: string; hint?: string; shortcut?: string; locked?: string; run?: () => void }
type Section = { title?: string; entries: Entry[]; empty?: string }

const has = (text: string, q: string) => text.toLowerCase().includes(q)

function actionEntry(a: Action): Entry {
  return { key: a.id, icon: a.icon ?? "bolt", label: a.label, shortcut: a.shortcut, locked: a.locked, run: a.run }
}

function chatEntries(q: string): Entry[] {
  return threadOrder()
    .filter((t) => !q || has(threadTitle(t), q))
    .map((t) => ({ key: `chat-${t.id}`, icon: "chat", label: threadTitle(t), hint: t.cwd === WORKSPACE ? PROJECT : undefined, run: () => void openThread(t.id) }))
}

/** Picking a file opens it in a file tab of the tabs pane. */
function fileEntry(path: string): Entry {
  return {
    key: `file-${path}`,
    icon: "file",
    label: path.split("/").pop() ?? path,
    hint: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined,
    run: () => openFile(path),
  }
}

async function searchFiles(query: string): Promise<string[]> {
  try {
    const res = await call<FuzzyFileSearchResponse>("fuzzyFileSearch", { query, roots: [WORKSPACE], cancellationToken: null })
    return res.files.slice(0, 20).map((f) => f.path)
  } catch {
    return []
  }
}

/** Messages in any chat that contain the query, with a snippet around the match. */
async function searchText(query: string): Promise<Entry[]> {
  const found: Entry[] = []
  for (const thread of threadOrder().slice(0, 50)) {
    for (const turn of await loadTurns(thread.id)) {
      for (const item of turn.items) {
        const text = item.type === "agentMessage" || item.type === "plan" ? item.text : item.type === "userMessage" ? item.content.map((c) => ("text" in c ? c.text : "")).join(" ") : ""
        const at = text.toLowerCase().indexOf(query)
        if (at < 0) continue
        const start = Math.max(0, at - 30)
        const snippet = `${start ? "…" : ""}${text.slice(start, at + query.length + 60).replace(/\s+/g, " ")}`
        found.push({ key: `text-${item.id}`, icon: "chat", label: snippet, hint: threadTitle(thread), run: () => void openThread(thread.id) })
        if (found.length >= 30) return found
      }
    }
  }
  return found
}

export function CommandMenu() {
  return (
    <Show when={state.commandMenu}>
      {(tab) => <Dialog tab={tab()} />}
    </Show>
  )
}

function Dialog(props: { tab: CommandTab }) {
  const [query, setQuery] = createSignal("")
  const [settled, setSettled] = createSignal("")
  const [active, setActive] = createSignal(0)
  let input!: HTMLInputElement
  let list!: HTMLDivElement

  // Engine searches wait for a short pause in typing.
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(on(query, (q) => {
    clearTimeout(timer)
    timer = setTimeout(() => setSettled(q.trim().toLowerCase()), 120)
  }))
  onCleanup(() => clearTimeout(timer))

  const q = () => query().trim().toLowerCase()
  const [files] = createResource(
    () => ((props.tab === "files" || props.tab === "all") && settled() ? settled() : null),
    searchFiles,
  )
  const [text] = createResource(() => (props.tab === "text" && settled() ? settled() : null), searchText)

  const sections = createMemo((): Section[] => {
    const query = q()
    const actions = ACTIONS.filter((a) => a.when?.() ?? true)
    switch (props.tab) {
      case "all":
        if (!query) {
          return [
            { title: "Quick actions", entries: actions.filter((a) => a.id === "new-chat" || a.id === "open-folder").map(actionEntry) },
            { title: "Chats", entries: chatEntries("").slice(0, 10) },
          ]
        }
        return [
          { title: "Actions", entries: actions.filter((a) => has(a.label, query)).slice(0, 6).map(actionEntry) },
          { title: "Chats", entries: chatEntries(query).slice(0, 6) },
          { title: "Files", entries: (files() ?? []).slice(0, 6).map(fileEntry) },
        ]
      case "actions":
        return [{ entries: actions.filter((a) => !query || has(a.label, query)).map(actionEntry), empty: "No matching actions" }]
      case "chats":
        return [{ entries: chatEntries(query), empty: "No chats" }]
      case "files":
        return query
          ? [{ entries: (files() ?? []).map(fileEntry), empty: files.loading ? "Searching…" : "No matching files" }]
          : [{ title: "Opened recently", entries: state.recentFiles.map(fileEntry), empty: "No recent files" }]
      case "text":
        return query
          ? [{ entries: text() ?? [], empty: text.loading || settled() !== query ? "Searching…" : "No matches" }]
          : [{ entries: [], empty: "Type to search what was said in your chats" }]
    }
  })
  const entries = createMemo(() => sections().flatMap((s) => s.entries))
  createEffect(on([() => props.tab, q], () => setActive(Math.max(0, entries().findIndex((e) => e.run && !e.locked)))))
  createEffect(on(active, (i) => list?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" })))
  queueMicrotask(() => input?.focus())

  const run = (entry: Entry | undefined) => {
    if (!entry?.run || entry.locked) return
    closeCommandMenu()
    entry.run()
  }
  const cycle = (delta: number) => {
    const at = TABS.findIndex((t) => t.id === props.tab)
    openCommandMenu(TABS[(at + delta + TABS.length) % TABS.length]!.id)
    input.focus()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const n = entries().length
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      closeCommandMenu()
    } else if (e.key === "Tab") {
      e.preventDefault()
      cycle(e.shiftKey ? -1 : 1)
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
    <div class="cx-scrim cx-scrim-top" onMouseDown={(e) => e.target === e.currentTarget && closeCommandMenu()}>
      <div class="cx-command" role="dialog" aria-label="Command menu" aria-description="Search chats, actions, and project files" onKeyDown={onKeyDown}>
        <div class="cx-command-tabs" role="tablist">
          <For each={TABS}>
            {(t) => (
              <button role="tab" class="cx-command-tab" aria-selected={props.tab === t.id} onClick={() => (openCommandMenu(t.id), input.focus())}>
                {t.label}
              </button>
            )}
          </For>
          <kbd class="cx-menu-kbd">Tab</kbd>
          <div class="cx-grow" />
          <Show when={props.tab === "files"}>
            <button class="cx-chip" disabled title="This task has one project">
              Project: {PROJECT} <Icon name="chevronDown" size={12} />
            </button>
          </Show>
        </div>
        <input
          ref={input}
          class="cx-command-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="cx-command-list"
          placeholder={TABS.find((t) => t.id === props.tab)!.placeholder}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div class="cx-command-list" id="cx-command-list" role="listbox" aria-label="Suggestions" ref={list}>
          <For each={sections()}>
            {(section) => (
              <Show when={section.entries.length || section.empty}>
                <Show when={section.title && section.entries.length}>
                  <div class="cx-command-heading">{section.title}</div>
                </Show>
                <For each={section.entries} fallback={<div class="cx-empty-row">{section.empty}</div>}>
                  {(entry) => {
                    const i = entries().indexOf(entry)
                    return (
                      <button
                        role="option"
                        class="cx-command-row"
                        data-index={i}
                        aria-selected={active() === i}
                        aria-disabled={!entry.run || !!entry.locked}
                        data-locked={entry.locked ? "" : undefined}
                        onMouseMove={() => setActive(i)}
                        onClick={() => run(entry)}
                      >
                        <Icon name={entry.icon} size={15} />
                        <span class="cx-command-label">{entry.label}</span>
                        <Show when={entry.locked}>
                          <span class="cx-lock-note">
                            <Icon name="lock" size={12} /> {entry.locked}
                          </span>
                        </Show>
                        <div class="cx-grow" />
                        <Show when={entry.hint}>
                          <span class="cx-command-hint">{entry.hint}</span>
                        </Show>
                        <Show when={entry.shortcut}>
                          <kbd class="cx-menu-kbd">{entry.shortcut}</kbd>
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </Show>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
