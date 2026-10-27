// Window chrome: title bar with menus, left rail, and the sidebar with projects and chats.
import { createEffect, For, Show } from "solid-js"
import { Icon, type IconName } from "../icons"
import { MenuList, Popover, type MenuItem } from "./popover"
import { prefs, setPref } from "../prefs"
import {
  archive,
  goHome,
  loadReply,
  openCommandMenu,
  openSettings,
  openTerminal,
  openThread,
  pin,
  PROJECT,
  requestFor,
  setPage,
  showToast,
  state,
  threadOrder,
  threadTitle,
  toggleSidebar,
  WORKSPACE,
  type ThreadView,
} from "../store"

const LOCKED = "Not available in this task"

const MENUS: Record<string, MenuItem[]> = {
  File: [
    { label: "New Window", locked: LOCKED },
    { label: "New Chat", shortcut: "Ctrl+N", onSelect: goHome },
    { label: "New Temporary Chat", shortcut: "Ctrl+Shift+N", disabled: true },
    { label: "New Project…", locked: LOCKED },
    { label: "Open Folder…", shortcut: "Ctrl+O", locked: LOCKED },
    { separator: true },
    { label: "Settings…", shortcut: "Ctrl+,", onSelect: () => openSettings() },
    { separator: true },
    { label: "Log Out", locked: LOCKED },
  ],
  Edit: [
    { label: "Undo", shortcut: "Ctrl+Z", onSelect: () => document.execCommand("undo") },
    { label: "Redo", shortcut: "Ctrl+Shift+Z", onSelect: () => document.execCommand("redo") },
    { separator: true },
    { label: "Cut", shortcut: "Ctrl+X", onSelect: () => document.execCommand("cut") },
    { label: "Copy", shortcut: "Ctrl+C", onSelect: () => document.execCommand("copy") },
    { label: "Paste", shortcut: "Ctrl+V", disabled: true },
    { label: "Select All", shortcut: "Ctrl+A", onSelect: () => document.execCommand("selectAll") },
  ],
  View: [
    { label: "Toggle Sidebar", shortcut: "Ctrl+Shift+S", onSelect: toggleSidebar },
    { label: "Toggle Bottom Panel", shortcut: "Ctrl+J", disabled: true },
    { label: "Toggle Pinned Summary", disabled: true },
    {
      label: "Open Terminal",
      shortcut: "Ctrl+`",
      get locked() {
        return state.terminal ? undefined : LOCKED
      },
      onSelect: openTerminal,
    },
    { separator: true },
    { label: "Find", shortcut: "Ctrl+F", disabled: true },
    { label: "Back", shortcut: "Ctrl+[", disabled: true },
    { label: "Forward", disabled: true },
  ],
  Help: [
    { label: "Documentation", onSelect: () => window.parent?.postMessage({ type: "agentsim:help" }, location.origin) },
    { label: "Keyboard Shortcuts", shortcut: "Ctrl+/", onSelect: () => openSettings("shortcuts") },
    { label: "Send Feedback", locked: LOCKED },
  ],
}

export function TitleBar() {
  return (
    <header class="cx-titlebar">
      <button class="cx-icon-btn" aria-label="Back" disabled>
        <Icon name="chevronLeft" />
      </button>
      <button class="cx-icon-btn" aria-label="Forward" disabled>
        <Icon name="chevronRight" />
      </button>
      <button class="cx-icon-btn" aria-label={state.sidebar ? "Hide sidebar" : "Show sidebar"} onClick={toggleSidebar}>
        <Icon name="sidebar" />
      </button>
      <nav class="cx-menubar">
        <For each={Object.entries(MENUS)}>
          {([name, items]) => (
            <Popover trigger={(open, toggle) => <button class="cx-menubar-item" data-open={open() ? "" : undefined} onClick={toggle}>{name}</button>}>
              {(close) => <MenuList items={items} close={close} />}
            </Popover>
          )}
        </For>
      </nav>
    </header>
  )
}

const RAIL: { icon: IconName; label: string; page: "home" | "scheduled" | "plugins" | "explore" }[] = [
  { icon: "home", label: "Home", page: "home" },
  { icon: "clock", label: "Scheduled", page: "scheduled" },
  { icon: "plugins", label: "Plugins", page: "plugins" },
  { icon: "explore", label: "Explore", page: "explore" },
]

export function Rail() {
  return (
    <nav class="cx-rail" aria-label="Navigation">
      <For each={RAIL}>
        {(entry) => (
          <button
            class="cx-rail-btn"
            aria-label={entry.label}
            title={entry.label}
            data-active={state.page === entry.page || (entry.page === "home" && state.page === "thread") ? "" : undefined}
            onClick={() => (entry.page === "home" ? goHome() : setPage(entry.page))}
          >
            <Icon name={entry.icon} size={18} />
          </button>
        )}
      </For>
      <div class="cx-rail-spacer" />
      <Popover
        placement="above"
        trigger={(_, toggle) => (
          <button class="cx-rail-btn" aria-label="Open profile menu" title="Open profile menu" onClick={toggle}>
            <Icon name="gear" size={18} />
          </button>
        )}
      >
        {(close) => (
          <MenuList
            close={close}
            items={[
              { label: "Settings", shortcut: "Ctrl+,", onSelect: () => openSettings() },
              { label: "Keyboard shortcuts", shortcut: "Ctrl+/", onSelect: () => openSettings("shortcuts") },
              { separator: true },
              { label: "Log out", locked: LOCKED },
            ]}
          />
        )}
      </Popover>
    </nav>
  )
}

// A chat row; on hover it shows Pin chat and Archive chat, as in the original.
/** A reply as one line of plain text for a preview (markdown marks and code fences dropped). */
const plain = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`|[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()

function ThreadRow(props: { thread: ThreadView; indent?: boolean; preview?: string }) {
  const pending = () => requestFor(props.thread.id)
  const running = () => props.thread.status?.type === "active"
  const pinned = () => prefs.pinned.includes(props.thread.id)
  return (
    <div
      class="cx-thread-row"
      data-indent={props.indent ? "" : undefined}
      data-active={state.activeId === props.thread.id ? "" : undefined}
    >
      <button class="cx-thread-open" onClick={() => void openThread(props.thread.id)}>
        <Show when={pinned()}>
          <Icon name="pin" size={12} class="cx-pin-mark" />
        </Show>
        <span class="cx-thread-text">
          <span class="cx-thread-title">{threadTitle(props.thread)}</span>
          <Show when={props.preview}>
            <span class="cx-thread-preview">{props.preview}</span>
          </Show>
        </span>
      </button>
      <Show when={pending()}>
        <span class="cx-pill" data-kind={pending()!.method.includes("requestUserInput") ? "input" : "approval"}>
          {pending()!.method.includes("requestUserInput") ? "Needs input" : "Awaiting approval"}
        </span>
      </Show>
      <Show when={running() && !pending()}>
        <span class="cx-spinner" aria-label="Running" />
      </Show>
      <span class="cx-row-actions">
        <button class="cx-icon-btn cx-small" aria-label={pinned() ? "Unpin chat" : "Pin chat"} title={pinned() ? "Unpin chat" : "Pin chat"} onClick={() => pin(props.thread.id)}>
          <Icon name="pin" size={14} />
        </button>
        <button class="cx-icon-btn cx-small" aria-label="Archive chat" title="Archive chat" onClick={() => void archive(props.thread.id)}>
          <Icon name="archive" size={14} />
        </button>
      </span>
    </div>
  )
}

const DAY = 86_400_000

/** Date groups for the activity view, newest first. */
function byDate(threads: ThreadView[]) {
  const today = new Date().setHours(0, 0, 0, 0)
  const groups: [string, (ms: number) => boolean][] = [
    ["Today", (ms) => ms >= today],
    ["Yesterday", (ms) => ms >= today - DAY],
    ["Previous 7 days", (ms) => ms >= today - 7 * DAY],
    ["Previous 30 days", (ms) => ms >= today - 30 * DAY],
    ["Older", () => true],
  ]
  const sorted = [...threads].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
  const out: { label: string; threads: ThreadView[] }[] = []
  for (const thread of sorted) {
    const ms = Number(thread.updatedAt ?? 0) * 1000
    const label = groups.find(([, test]) => test(ms))![0]
    const group = out.find((g) => g.label === label)
    if (group) group.threads.push(thread)
    else out.push({ label, threads: [thread] })
  }
  return out
}

/** The activity view (S04): what needs you first, then chats by date with their last reply. */
function Activity() {
  const waiting = () => threadOrder().filter((t) => requestFor(t.id))
  const rest = () => threadOrder().filter((t) => !requestFor(t.id))
  // Previews of chats not opened yet come from their history, read once.
  createEffect(() => {
    if (prefs.activityPreviews) for (const thread of threadOrder()) void loadReply(thread.id)
  })
  const preview = (thread: ThreadView) => (prefs.activityPreviews ? plain(state.lastReply[thread.id] ?? "") || undefined : undefined)
  return (
    <>
      <section class="cx-section">
        <div class="cx-section-head">
          <span>Priority</span>
          <div class="cx-grow" />
          <Popover
            align="end"
            class="cx-wide-menu"
            trigger={(_, toggle) => (
              <button class="cx-icon-btn cx-small" aria-label="Activity view options" onClick={toggle}>
                <Icon name="more" size={14} />
              </button>
            )}
          >
            {(close) => (
              <MenuList
                close={close}
                items={[
                  { label: "Show previews", checked: prefs.activityPreviews, onSelect: () => setPref("activityPreviews", !prefs.activityPreviews) },
                  { separator: true },
                  { label: "Turn off activity view", shortcut: "Ctrl+Alt+U", onSelect: () => setPref("activityView", false) },
                ]}
              />
            )}
          </Popover>
        </div>
        <For each={waiting()} fallback={<div class="cx-empty-row">Nothing needs attention</div>}>
          {(thread) => <ThreadRow thread={thread} preview={preview(thread)} />}
        </For>
      </section>
      <For each={byDate(rest())}>
        {(group) => (
          <section class="cx-section">
            <div class="cx-section-head">
              <span>{group.label}</span>
            </div>
            <For each={group.threads}>{(thread) => <ThreadRow thread={thread} preview={preview(thread)} />}</For>
          </section>
        )}
      </For>
    </>
  )
}

export function Sidebar() {
  const projectThreads = () => threadOrder().filter((t) => t.cwd === WORKSPACE)
  const attention = () => Object.keys(state.requests).length > 0
  return (
    <aside class="cx-sidebar" aria-label="Sidebar">
      <div class="cx-sidebar-head">
        <Popover
          trigger={(_, toggle) => (
            <button class="cx-mode-btn" aria-label="Switch mode, current mode: Cosmodex" onClick={toggle}>
              Cosmodex <Icon name="chevronDown" size={14} />
            </button>
          )}
        >
          {(close) => (
            <MenuList
              close={close}
              items={[
                { label: "Chat", subtitle: "Create, learn, and explore", locked: LOCKED },
                { label: "Cosmodex", subtitle: "Build, edit, and debug code", checked: true },
              ]}
            />
          )}
        </Popover>
        <div class="cx-grow" />
        <button
          class="cx-icon-btn"
          data-on={prefs.activityView ? "" : undefined}
          aria-label={prefs.activityView ? "Turn off activity view" : attention() ? "View activity, needs attention" : "View activity"}
          aria-pressed={prefs.activityView}
          onClick={() => setPref("activityView", !prefs.activityView)}
        >
          <Icon name="bell" />
          <Show when={attention()}>
            <span class="cx-dot" />
          </Show>
        </button>
        <button class="cx-icon-btn" aria-label="Search" onClick={() => openCommandMenu("all")}>
          <Icon name="search" />
        </button>
      </div>

      <button class="cx-sidebar-action" onClick={goHome}>
        <Icon name="pencil" /> New chat
      </button>

      <Show when={!prefs.activityView} fallback={<Activity />}>
      <section class="cx-section">
        <div class="cx-section-head">
          <span>Projects</span>
          <div class="cx-grow" />
          <button class="cx-icon-btn cx-small" aria-label="Add new project" onClick={() => showToast("Blocked by the simulation: projects can't be changed here.")}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        <button class="cx-project-row" onClick={goHome}>
          <Icon name="folder" /> <span>{PROJECT}</span>
        </button>
        <For each={projectThreads()} fallback={<div class="cx-empty-row">No chats</div>}>
          {(thread) => <ThreadRow thread={thread} indent />}
        </For>
      </section>

      <section class="cx-section">
        <div class="cx-section-head">
          <span>Recents</span>
        </div>
        <For each={threadOrder()} fallback={<div class="cx-empty-row">No chats</div>}>
          {(thread) => <ThreadRow thread={thread} />}
        </For>
      </section>
      </Show>
    </aside>
  )
}
