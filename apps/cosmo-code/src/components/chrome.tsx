// The window frame: title bar (menu, sidebar, back/forward · session title · pane toggles), the
// sidebar (New, Customize, the folder's sessions, account and search), and the session rail
// (Environment and Context cards) on the right.
import { createSignal, For, Show } from "solid-js"
import { Icon, type IconName } from "../icons"
import { MenuList, Popover, type MenuItem } from "./popover"
import {
  activeSession,
  archive,
  FOLDER,
  fork,
  newSession,
  openPalette,
  openSession,
  rename,
  requestFor,
  setRenamingTitle,
  sessionOrder,
  showToast,
  state,
  togglePane,
  toggleRail,
  toggleSidebar,
  WORKSPACE,
  type Session,
} from "../store"

const LOCKED = "Not available in this task"
export const soon = () => showToast("This part of Cosmo Code isn't available yet.")

/** The session's menu (row "More options" and the title's ⌄): rename, fork, archive; deleting a
 * transcript isn't something a task allows. */
export function sessionMenu(session: Session, startRename: () => void): MenuItem[] {
  return [
    { label: "Open in", locked: LOCKED },
    { label: "Rename", shortcut: "R", onSelect: startRename },
    { label: "Fork", shortcut: "F", onSelect: () => void fork(session.id) },
    { label: "Archive", shortcut: "A", onSelect: () => void archive(session.id) },
    { separator: true },
    { label: "Delete", shortcut: "D", locked: LOCKED },
  ]
}

export function RenameField(props: { session: Session; done: () => void; class?: string }) {
  const [value, setValue] = createSignal(props.session.title)
  const finish = (save: boolean) => {
    if (save) void rename(props.session.id, value())
    props.done()
  }
  return (
    <input
      class={`cc-rename ${props.class ?? ""}`}
      aria-label="Session name"
      value={value()}
      ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
      onInput={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true)
        else if (e.key === "Escape") finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}

function Toggle(props: { icon: IconName; label: string; shortcut?: string; pressed?: boolean; onClick?: () => void }) {
  return (
    <button
      class="cc-icon-btn"
      aria-label={props.label}
      aria-pressed={props.pressed ?? false}
      aria-keyshortcuts={props.shortcut}
      title={props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
      onClick={props.onClick ?? soon}
    >
      <Icon name={props.icon} size={17} />
    </button>
  )
}

export function TitleBar() {
  // Renaming starts from the title, its menu, or /rename.
  const renaming = () => state.renamingTitle
  const setRenaming = setRenamingTitle
  const session = () => activeSession()
  return (
    <header class="cc-titlebar">
      <div class="cc-titlebar-left" data-collapsed={state.sidebar ? undefined : ""}>
        <button class="cc-icon-btn" aria-label="Menu" onClick={soon}>
          <Icon name="menu" size={17} />
        </button>
        <button class="cc-icon-btn" aria-label={state.sidebar ? "Hide sidebar" : "Show sidebar"} aria-keyshortcuts="Control+B" onClick={toggleSidebar}>
          <Icon name="sidebar" size={17} />
        </button>
        <button class="cc-icon-btn" aria-label="Back" disabled>
          <Icon name="back" size={17} />
        </button>
        <button class="cc-icon-btn" aria-label="Forward" disabled>
          <Icon name="forward" size={17} />
        </button>
      </div>
      <div class="cc-titlebar-title">
        <Show when={session()} fallback={<h1 class="cc-title cc-muted">New session</h1>}>
          {(s) => (
            <Show when={!renaming()} fallback={<RenameField session={s()} done={() => setRenaming(false)} class="cc-title-rename" />}>
              <h1 class="cc-title">
                <button class="cc-title-btn" aria-label={`${s().title}, rename session`} onClick={() => setRenaming(true)}>
                  {s().title}
                </button>
              </h1>
              <Popover
                trigger={(_, toggle) => (
                  <button class="cc-icon-btn cc-small" aria-label={`More options for ${s().title}`} onClick={toggle}>
                    <Icon name="chevronDown" size={15} />
                  </button>
                )}
              >
                {(close) => <MenuList close={close} items={sessionMenu(s(), () => setRenaming(true))} />}
              </Popover>
            </Show>
          )}
        </Show>
      </div>
      <div class="cc-titlebar-right">
        <Show when={session()}>
          <Toggle icon="rail" label="Session rail" pressed={state.rail && !state.pane} onClick={toggleRail} />
        </Show>
        <Toggle icon="terminal" label="Terminal" shortcut="Control+`" pressed={state.pane === "terminal"} onClick={() => togglePane("terminal")} />
        <Show when={session()}>
          <Toggle icon="changes" label="Changes" shortcut="Control+Shift+D" pressed={state.pane === "changes"} onClick={() => togglePane("changes")} />
          <Toggle icon="play" label="Preview" shortcut="Control+Shift+P" />
        </Show>
        <Toggle icon="folder" label="Files" shortcut="Control+Shift+F" pressed={state.pane === "files"} onClick={() => togglePane("files")} />
        <Show when={session()}>
          <Toggle icon="moreVertical" label="View options" />
        </Show>
      </div>
    </header>
  )
}

function SessionRow(props: { session: Session }) {
  const [renaming, setRenaming] = createSignal(false)
  const waiting = () => !!requestFor(props.session.id)
  return (
    <div class="cc-session-row" data-active={state.activeId === props.session.id ? "" : undefined}>
      <Show when={!renaming()} fallback={<RenameField session={props.session} done={() => setRenaming(false)} />}>
        <button class="cc-session-open" onClick={() => void openSession(props.session.id)}>
          <span class="cc-session-title">{props.session.title}</span>
        </button>
        <Show when={waiting() || props.session.state === "running"}>
          <span class="cc-status-dot" data-kind={waiting() ? "attention" : "running"} aria-label={waiting() ? "Needs your input" : "Working"} />
        </Show>
        <Popover
          align="end"
          trigger={(_, toggle) => (
            <button class="cc-icon-btn cc-small cc-row-more" aria-label={`More options for ${props.session.title}`} onClick={toggle}>
              <Icon name="more" size={15} />
            </button>
          )}
        >
          {(close) => <MenuList close={close} items={sessionMenu(props.session, () => setRenaming(true))} />}
        </Popover>
      </Show>
    </div>
  )
}

export function Sidebar() {
  const [open, setOpen] = createSignal(true)
  return (
    <aside class="cc-sidebar" aria-label="Sidebar">
      <button class="cc-side-action" aria-keyshortcuts="Control+N" data-active={state.activeId ? undefined : ""} onClick={newSession}>
        <Icon name="plus" size={16} /> New
      </button>
      <button class="cc-side-action" onClick={soon}>
        <Icon name="briefcase" size={16} /> Customize
      </button>
      <Show
        when={sessionOrder().length}
        fallback={<p class="cc-side-empty">Sessions you start will show up here</p>}
      >
        <section class="cc-group">
          <div class="cc-group-head">
            <button class="cc-group-name" aria-expanded={open()} onClick={() => setOpen((v) => !v)}>
              {FOLDER}
            </button>
            <div class="cc-grow" />
            <button class="cc-icon-btn cc-small" aria-label={`New session in ${FOLDER}`} onClick={newSession}>
              <Icon name="plus" size={15} />
            </button>
          </div>
          <Show when={open()}>
            <For each={sessionOrder()}>{(session) => <SessionRow session={session} />}</For>
          </Show>
        </section>
      </Show>
      <div class="cc-grow" />
      <footer class="cc-side-foot">
        <button class="cc-account" aria-label="runner Gateway" onClick={soon}>
          <span class="cc-avatar" aria-hidden="true">r</span> runner <span class="cc-muted">· Gateway</span>
          <Icon name="chevronDown" size={13} />
        </button>
        <div class="cc-grow" />
        <button class="cc-icon-btn" aria-label="Search" aria-keyshortcuts="Control+Shift+K" onClick={() => openPalette()}>
          <Icon name="search" size={16} />
        </button>
      </footer>
    </aside>
  )
}

/** The session rail: where the session runs, and how full its context is. */
export function SessionRail() {
  const s = () => activeSession()!
  const pct = () => Math.round(s().context?.percentage ?? 0)
  return (
    <aside class="cc-rail" aria-label="Session details">
      <section class="cc-card">
        <button class="cc-card-head" aria-expanded="true">
          Environment <Icon name="chevronDown" size={13} />
        </button>
        <div class="cc-card-row">
          <Icon name="laptop" size={15} /> This computer
          <div class="cc-grow" />
          <button class="cc-link-btn" title={LOCKED} disabled>
            Save
          </button>
        </div>
        <div class="cc-card-row">
          <Icon name="folder" size={15} /> {FOLDER} <span class="cc-muted">· {WORKSPACE.slice(0, WORKSPACE.lastIndexOf("/")) || "/"}</span>
        </div>
      </section>
      <section class="cc-card">
        <div class="cc-card-row cc-card-head-row">
          <span>Context</span> <Icon name="chevronRight" size={13} />
          <div class="cc-grow" />
          <span class="cc-muted">{pct()}%</span>
          <span class="cc-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(4, pct())}%` }} />
          </span>
        </div>
      </section>
    </aside>
  )
}
