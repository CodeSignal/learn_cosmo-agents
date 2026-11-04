// The window frame: title bar (menu, sidebar, back/forward · session title · pane toggles), the
// sidebar (New, Customize; Pinned, the candidate's sections and the folder's sessions, with Group
// and sort; the account menu and search), and the session rail on the right (Environment, Context,
// Outputs, Changes).
import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { Icon, type IconName } from "../icons"
import { MenuList, Popover, type MenuItem } from "./popover"
import {
  addSection,
  deleteSection,
  moveToSection,
  prefs,
  renameSection,
  setPinned,
  setPref,
  setSessionView,
  setUnread,
  SIDEBAR_DEFAULTS,
  toggleCollapsed,
  viewOf,
  type SortBy,
  type TranscriptView,
} from "../prefs"
import { parseDiff, totals } from "../diff"
import {
  activeSession,
  archive,
  FOLDER,
  fork,
  newSession,
  closePane,
  openFileInPane,
  openHelp,
  openPalette,
  openPreview,
  openSession,
  openSettings,
  previewable,
  rename,
  requestFor,
  setRenamingTitle,
  sessionOrder,
  showToast,
  state,
  stepSession,
  togglePane,
  toggleRail,
  toggleShortcuts,
  toggleSidebar,
  WORKSPACE,
  type Session,
} from "../store"
import { COSMO } from "../engine"

const LOCKED = "Not available in this task"
export const soon = () => showToast("This part of Cosmo Code isn't available yet.")

const VIEWS: { value: TranscriptView; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "thinking", label: "Thinking" },
  { value: "verbose", label: "Verbose" },
]

/** The section being named in the sidebar (right after New section). */
const [renamingSection, setRenamingSection] = createSignal<string | null>(null)

const openIn = (): MenuItem => ({
  label: "Open in",
  submenu: [
    { label: "Split view", shortcut: "1", locked: LOCKED },
    { label: "New window", shortcut: "2", locked: LOCKED },
    { label: "File manager", shortcut: "3", locked: LOCKED },
  ],
})

/** The title's menu (S41): rename, fork, the session's transcript view, archive. Deleting a
 * transcript isn't something a task allows. */
export function sessionMenu(session: Session, startRename: () => void): MenuItem[] {
  return [
    openIn(),
    { label: "Rename", shortcut: "R", onSelect: startRename },
    { label: "Fork", shortcut: "F", onSelect: () => void fork(session.id) },
    {
      label: "Transcript view",
      submenu: VIEWS.map((v) => ({ label: v.label, checked: viewOf(session.id) === v.value, onSelect: () => setSessionView(session.id, v.value) })),
    },
    { label: "Output style", locked: "Set by this task" },
    { label: "Archive", shortcut: "A", onSelect: () => void archive(session.id) },
    { separator: true },
    { label: "Delete", shortcut: "D", locked: LOCKED },
  ]
}

/** A sidebar row's menu (S10): also pin, unread and sections. */
function rowMenu(session: Session, startRename: () => void): MenuItem[] {
  const pinned = prefs.pinned.includes(session.id)
  const unread = prefs.unread.includes(session.id)
  const current = prefs.sectionOf[session.id]
  return [
    openIn(),
    { separator: true },
    { label: pinned ? "Unpin" : "Pin", shortcut: "P", onSelect: () => setPinned(session.id, !pinned) },
    { label: unread ? "Mark as read" : "Mark as unread", shortcut: "U", onSelect: () => setUnread(session.id, !unread) },
    { label: "Rename", shortcut: "R", onSelect: startRename },
    { label: "Fork", shortcut: "F", onSelect: () => void fork(session.id) },
    { separator: true },
    {
      label: "Move to section",
      submenu: [
        ...prefs.sections.map((sec, i) => ({
          label: sec.name,
          shortcut: i < 8 ? String(i + 1) : undefined,
          checked: current === sec.id,
          onSelect: () => moveToSection(session.id, sec.id),
        })),
        ...(current ? [{ label: "Remove from section", onSelect: () => moveToSection(session.id, null) }] : []),
        ...(prefs.sections.length ? [{ separator: true } as const] : []),
        {
          label: "New section",
          shortcut: prefs.sections.length < 9 ? String(prefs.sections.length + 1) : undefined,
          onSelect: () => setRenamingSection(addSection(session.id)),
        },
      ],
    },
    { separator: true },
    { label: "Archive", shortcut: "A", onSelect: () => void archive(session.id) },
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

/** The app menu (S15, the title bar's Menu): File, Edit, View, Go and Help. Window and app
 * features a browser page doesn't have (zoom, full screen, split view, logs) are locked. */
function appMenu(): MenuItem[] {
  const pane = (p: Parameters<typeof togglePane>[0]) => () => togglePane(p)
  return [
    {
      label: "File",
      submenu: [
        { label: "New Session", shortcut: "Ctrl+N", onSelect: newSession },
        { separator: true },
        { label: "Settings…", shortcut: "Ctrl+,", onSelect: () => openSettings() },
        { separator: true },
        { label: "Close Pane", shortcut: "Ctrl+\\", disabled: !state.pane, onSelect: closePane },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", shortcut: "Ctrl+Z", onSelect: () => document.execCommand("undo") },
        { label: "Redo", shortcut: "Ctrl+Shift+Z", onSelect: () => document.execCommand("redo") },
        { separator: true },
        { label: "Cut", shortcut: "Ctrl+X", onSelect: () => document.execCommand("cut") },
        { label: "Copy", shortcut: "Ctrl+C", onSelect: () => document.execCommand("copy") },
        { label: "Paste", shortcut: "Ctrl+V", disabled: true },
        { label: "Select All", shortcut: "Ctrl+A", onSelect: () => document.execCommand("selectAll") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Command Palette…", shortcut: "Ctrl+K", onSelect: () => openPalette() },
        { label: "Sidebar", shortcut: "Ctrl+B", checked: state.sidebar, onSelect: toggleSidebar },
        { label: "Terminal", shortcut: "Ctrl+`", checked: state.pane === "terminal", onSelect: pane("terminal") },
        { label: "Changes", shortcut: "Ctrl+Shift+D", checked: state.pane === "changes", disabled: !activeSession(), onSelect: pane("changes") },
        { label: "Preview", shortcut: "Ctrl+Shift+P", checked: state.pane === "preview", disabled: !activeSession(), onSelect: pane("preview") },
        { label: "Files", shortcut: "Ctrl+Shift+F", checked: state.pane === "files", onSelect: pane("files") },
        { label: "Side Chat", shortcut: "Ctrl+;", checkable: true, locked: LOCKED },
        { label: "Session Rail", checked: !!activeSession() && state.rail && !state.pane, disabled: !activeSession(), onSelect: toggleRail },
        { label: "Close Pane", disabled: !state.pane, onSelect: closePane },
        { label: "Split View", locked: LOCKED },
        { separator: true },
        { label: "Actual Size", locked: LOCKED },
        { label: "Zoom In", locked: LOCKED },
        { label: "Zoom Out", locked: LOCKED },
        { label: "Full Screen", shortcut: "F11", locked: LOCKED },
        { separator: true },
        { label: "Reload", shortcut: "F5", onSelect: () => location.reload() },
      ],
    },
    {
      label: "Go",
      submenu: [
        { label: "Back", disabled: true },
        { label: "Forward", disabled: true },
        { separator: true },
        { label: "Next Session", shortcut: "Ctrl+Shift+]", onSelect: () => stepSession(1) },
        { label: "Previous Session", shortcut: "Ctrl+Shift+[", onSelect: () => stepSession(-1) },
        { label: "Search…", shortcut: "Ctrl+Shift+K", onSelect: () => openPalette() },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Cosmo Code Help", shortcut: "F1", onSelect: openHelp },
        { label: "Keyboard Shortcuts", shortcut: "Ctrl+/", onSelect: toggleShortcuts },
        {
          label: "Troubleshooting",
          submenu: ["Show Logs in File Manager", "Copy Installation ID", "Generate Diagnostic Report", "Clear Cache and Restart", "Reset App Data…"].map((label) => ({ label, locked: LOCKED })),
        },
        { label: "Get Support", locked: LOCKED },
        { label: "About Cosmo Code", onSelect: () => showToast(`Cosmo Code ${import.meta.env.VITE_VERSION ?? ""}`.trim()) },
      ],
    },
  ]
}

export function TitleBar() {
  // Renaming starts from the title, its menu, or /rename.
  const renaming = () => state.renamingTitle
  const setRenaming = setRenamingTitle
  const session = () => activeSession()
  return (
    <header class="cc-titlebar">
      <div class="cc-titlebar-left" data-collapsed={state.sidebar ? undefined : ""}>
        <Popover
          trigger={(open, toggle) => (
            <button class="cc-icon-btn" aria-label="Menu" aria-haspopup="menu" aria-expanded={open()} onClick={toggle}>
              <Icon name="menu" size={17} />
            </button>
          )}
        >
          {(close) => <MenuList close={close} items={appMenu()} />}
        </Popover>
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
          <Toggle icon="play" label="Preview" shortcut="Control+Shift+P" pressed={state.pane === "preview"} onClick={() => togglePane("preview")} />
        </Show>
        <Toggle icon="folder" label="Files" shortcut="Control+Shift+F" pressed={state.pane === "files"} onClick={() => togglePane("files")} />
        <Show when={session()}>
          <Popover
            align="end"
            trigger={(open, toggle) => (
              <button class="cc-icon-btn" aria-label="View options" aria-haspopup="menu" aria-expanded={open()} onClick={toggle}>
                <Icon name="moreVertical" size={17} />
              </button>
            )}
          >
            {(close) => (
              <MenuList
                close={close}
                items={[
                  { label: "Side chat", shortcut: "Ctrl+;", checkable: true, locked: LOCKED },
                  { label: "Background tasks", checked: state.pane === "tasks", onSelect: () => togglePane("tasks") },
                  { label: "Plan", checked: state.pane === "plan", onSelect: () => togglePane("plan") },
                ]}
              />
            )}
          </Popover>
        </Show>
      </div>
    </header>
  )
}

/** "5m", "2h", "3d", then the date: when a session was last updated (Show → Metadata). */
function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  if (m < 24 * 60) return `${Math.round(m / 60)}h`
  if (m < 7 * 24 * 60) return `${Math.round(m / 1440)}d`
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function SessionRow(props: { session: Session }) {
  const [renaming, setRenaming] = createSignal(false)
  const waiting = () => !!requestFor(props.session.id)
  const unread = () => prefs.unread.includes(props.session.id)
  return (
    <div class="cc-session-row" data-active={state.activeId === props.session.id ? "" : undefined} data-unread={unread() ? "" : undefined}>
      <Show when={!renaming()} fallback={<RenameField session={props.session} done={() => setRenaming(false)} />}>
        <button class="cc-session-open" onClick={() => void openSession(props.session.id)}>
          <span class="cc-session-title">{props.session.title}</span>
          <Show when={unread()}>
            <span class="cc-sr">, unread</span>
          </Show>
        </button>
        <Show when={prefs.showMetadata}>
          <span class="cc-session-meta cc-muted">{ago(props.session.lastModified)}</span>
        </Show>
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
          {(close) => <MenuList close={close} items={rowMenu(props.session, () => setRenaming(true))} />}
        </Popover>
      </Show>
    </div>
  )
}

const SORT_LABEL: Record<SortBy, string> = { updated: "Last updated", created: "Date created", name: "Name" }

/** Group and sort (S11): how the sidebar orders sessions and what rows show. */
function groupAndSort(): MenuItem[] {
  const atDefaults = (Object.keys(SIDEBAR_DEFAULTS) as (keyof typeof SIDEBAR_DEFAULTS)[]).every((k) => prefs[k] === SIDEBAR_DEFAULTS[k])
  return [
    { label: "Group by Folder", submenu: [{ label: "Folder", radio: true, checked: true }] },
    {
      label: `Sort by ${SORT_LABEL[prefs.sortBy]}`,
      submenu: [
        ...(Object.keys(SORT_LABEL) as SortBy[]).map((by) => ({ label: SORT_LABEL[by], radio: true, checked: prefs.sortBy === by, onSelect: () => setPref("sortBy", by) })),
        { separator: true },
        { label: "Descending", radio: true, checked: prefs.sortDir === "desc", onSelect: () => setPref("sortDir", "desc") },
        { label: "Ascending", radio: true, checked: prefs.sortDir === "asc", onSelect: () => setPref("sortDir", "asc") },
      ],
    },
    {
      label: "Show",
      submenu: [
        { label: "Metadata", checkable: true, checked: prefs.showMetadata, onSelect: () => setPref("showMetadata", !prefs.showMetadata) },
        { separator: true },
        { label: "Side chats", checkable: true, locked: LOCKED },
        { label: "Empty groups", checkable: true, checked: prefs.showEmptyGroups, onSelect: () => setPref("showEmptyGroups", !prefs.showEmptyGroups) },
      ],
    },
    { separator: true },
    { label: "New section", onSelect: () => setRenamingSection(addSection()) },
    { separator: true },
    {
      label: "Reset to defaults",
      disabled: atDefaults,
      subtitle: atDefaults ? "Grouping and sorting are already at their defaults." : undefined,
      onSelect: () => (Object.keys(SIDEBAR_DEFAULTS) as (keyof typeof SIDEBAR_DEFAULTS)[]).forEach((k) => setPref(k, SIDEBAR_DEFAULTS[k] as never)),
    },
    { label: "View all", disabled: true, subtitle: "There are no other sessions to view." },
  ]
}

function SectionName(props: { id: string; name: string }) {
  const finish = (value: string | null) => {
    if (value !== null) renameSection(props.id, value)
    setRenamingSection(null)
  }
  return (
    <input
      class="cc-rename"
      aria-label="Section name"
      value={props.name}
      ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value)
        else if (e.key === "Escape") finish(null)
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  )
}

/** One sidebar group: a header (collapses it) with its controls, and its sessions. */
function Group(props: { id: string; name: string; sessions: Session[]; controls?: JSX.Element; renaming?: boolean }) {
  const open = () => !prefs.collapsed[`group:${props.id}`]
  return (
    <section class="cc-group" aria-label={props.name}>
      <div class="cc-group-head">
        <Show when={!props.renaming} fallback={<SectionName id={props.id.replace(/^section:/, "")} name={props.name} />}>
          <button class="cc-group-name" aria-expanded={open()} onClick={() => toggleCollapsed(`group:${props.id}`)}>
            {props.name}
          </button>
        </Show>
        <div class="cc-grow" />
        {props.controls}
      </div>
      <Show when={open()}>
        <For each={props.sessions}>{(session) => <SessionRow session={session} />}</For>
      </Show>
    </section>
  )
}

export function Sidebar() {
  const sessions = () => sessionOrder()
  const pinned = () => sessions().filter((s) => prefs.pinned.includes(s.id))
  const sectionIds = () => new Set(prefs.sections.map((s) => s.id))
  const inSection = (id: string) => sessions().filter((s) => !prefs.pinned.includes(s.id) && prefs.sectionOf[s.id] === id)
  const rest = () => sessions().filter((s) => !prefs.pinned.includes(s.id) && !sectionIds().has(prefs.sectionOf[s.id] ?? ""))
  return (
    <aside class="cc-sidebar" aria-label="Sidebar">
      <button class="cc-side-action" aria-keyshortcuts="Control+N" data-active={state.activeId ? undefined : ""} onClick={newSession}>
        <Icon name="plus" size={16} /> New
      </button>
      <button class="cc-side-action" onClick={() => openSettings("skills")}>
        <Icon name="briefcase" size={16} /> Customize
      </button>
      <div class="cc-side-groups">
        <Show when={pinned().length}>
          <Group id="pinned" name="Pinned" sessions={pinned()} />
        </Show>
        <For each={prefs.sections}>
          {(section) => (
            <Group
              id={`section:${section.id}`}
              name={section.name}
              sessions={inSection(section.id)}
              renaming={renamingSection() === section.id}
              controls={
                <Popover
                  align="end"
                  trigger={(_, toggle) => (
                    <button class="cc-icon-btn cc-small cc-row-more" aria-label={`More options for ${section.name}`} onClick={toggle}>
                      <Icon name="more" size={15} />
                    </button>
                  )}
                >
                  {(close) => (
                    <MenuList
                      close={close}
                      items={[
                        { label: "Rename", shortcut: "R", onSelect: () => setRenamingSection(section.id) },
                        { label: "Delete section", shortcut: "D", subtitle: "Its sessions go back to their folder.", onSelect: () => deleteSection(section.id) },
                      ]}
                    />
                  )}
                </Popover>
              }
            />
          )}
        </For>
        <Show
          when={rest().length || (prefs.showEmptyGroups && sessions().length)}
          fallback={
            <Show when={!sessions().length}>
              <p class="cc-side-empty">Sessions you start will show up here</p>
            </Show>
          }
        >
          <Group
            id="folder"
            name={FOLDER}
            sessions={rest()}
            controls={
              <>
                <Popover
                  align="end"
                  trigger={(open, toggle) => (
                    <button class="cc-icon-btn cc-small cc-row-more" aria-label="Group and sort" aria-haspopup="menu" aria-expanded={open()} onClick={toggle}>
                      <Icon name="sort" size={15} />
                    </button>
                  )}
                >
                  {(close) => <MenuList close={close} items={groupAndSort()} />}
                </Popover>
                <button class="cc-icon-btn cc-small" aria-label={`New session in ${FOLDER}`} onClick={newSession}>
                  <Icon name="plus" size={15} />
                </button>
              </>
            }
          />
        </Show>
      </div>
      <footer class="cc-side-foot">
        <Popover
          placement="above"
          trigger={(open, toggle) => (
            <button class="cc-account" aria-label="runner Gateway" aria-haspopup="menu" aria-expanded={open()} onClick={toggle}>
              <span class="cc-avatar" aria-hidden="true">r</span> runner <span class="cc-muted">· Gateway</span>
              <Icon name="chevronDown" size={13} />
            </button>
          )}
        >
          {(close) => <MenuList close={close} items={accountMenu()} />}
        </Popover>
        <div class="cc-grow" />
        <button class="cc-icon-btn" aria-label="Search" aria-keyshortcuts="Control+Shift+K" onClick={() => openPalette()}>
          <Icon name="search" size={16} />
        </button>
      </footer>
    </aside>
  )
}

/** The account menu (S14): settings and shortcuts; the rest leaves the app, which a task doesn't. */
function accountMenu(): MenuItem[] {
  return [
    { label: "Settings", shortcut: "Ctrl+,", onSelect: () => openSettings("general") },
    { label: "Language", submenu: [{ label: "English", checked: true }] },
    { separator: true },
    { label: "View changelog", locked: LOCKED },
    {
      label: "Learn more",
      submenu: [
        ...["About Anthropic", "Tutorials", "Courses"].map((label) => ({ label, locked: LOCKED })),
        { separator: true },
        ...["Usage policy", "Privacy policy", "Commercial terms", "Your privacy choices"].map((label) => ({ label, locked: LOCKED })),
        { separator: true },
        { label: "Keyboard shortcuts", shortcut: "Ctrl+/", onSelect: toggleShortcuts },
      ],
    },
    { separator: true },
    { label: "Sign out", locked: LOCKED },
  ]
}

/** A session rail card (S31) with a header that collapses it. */
function Card(props: { id: string; title: string; children: JSX.Element }) {
  const open = () => !prefs.collapsed[`rail:${props.id}`]
  return (
    <section class="cc-card" aria-label={props.title}>
      <button class="cc-card-head" aria-expanded={open()} onClick={() => toggleCollapsed(`rail:${props.id}`)}>
        {props.title} <Icon name={open() ? "chevronDown" : "chevronRight"} size={13} />
      </button>
      <Show when={open()}>{props.children}</Show>
    </section>
  )
}

/** Files Claude wrote or edited in this session (in the workspace), the latest first. */
function outputs(session: Session): string[] {
  const done = new Set<string>()
  for (const m of session.messages) {
    if (m.type !== "user" || !Array.isArray(m.message?.content)) continue
    for (const b of m.message.content) if (b?.type === "tool_result" && !b.is_error) done.add(b.tool_use_id)
  }
  const files: string[] = []
  for (const m of session.messages) {
    if (m.type !== "assistant" || m.parent_tool_use_id || !Array.isArray(m.message?.content)) continue
    for (const b of m.message.content) {
      const file = String(b?.input?.file_path ?? b?.input?.notebook_path ?? "")
      if (b?.type !== "tool_use" || !["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(b.name) || !done.has(b.id) || !file.startsWith(`${WORKSPACE}/`)) continue
      const rel = file.slice(WORKSPACE.length + 1)
      const at = files.indexOf(rel)
      if (at >= 0) files.splice(at, 1)
      files.unshift(rel)
    }
  }
  return files
}

/** The session rail: where the session runs, how full its context is, what Claude wrote, and the
 * workspace's changes. */
export function SessionRail() {
  const s = () => activeSession()!
  const pct = () => Math.round(s().context?.percentage ?? 0)
  const [git] = createResource(
    () => ({ version: state.changesVersion, session: state.activeId }),
    () =>
      fetch(`${COSMO}/api/workspace/diff?scope=base`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null) as Promise<{ available: boolean; branch?: string | null; diff: string } | null>,
  )
  const change = createMemo(() => (git()?.available ? totals(parseDiff(git()!.diff)) : null))
  const files = createMemo(() => outputs(s()))
  const branch = () => git()?.branch ?? null
  return (
    <aside class="cc-rail" aria-label="Session details">
      <Card id="environment" title="Environment">
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
        <Show when={branch()}>
          <div class="cc-card-row" title={LOCKED}>
            <Icon name="branch" size={15} /> {branch()}
          </div>
        </Show>
      </Card>
      <section class="cc-card" aria-label={`Context ${pct()}%`}>
        <div class="cc-card-row cc-card-head-row">
          <span>Context</span> <Icon name="chevronRight" size={13} />
          <div class="cc-grow" />
          <span class="cc-muted">{pct()}%</span>
          <span class="cc-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(4, pct())}%` }} />
          </span>
        </div>
      </section>
      <Show when={files().length}>
        <Card id="outputs" title="Outputs">
          <For each={files()}>
            {(file) => (
              <button class="cc-card-row cc-card-file" title={file} onClick={() => (previewable(file) ? openPreview(file) : openFileInPane(file))}>
                <Icon name="file" size={15} /> <span class="cc-ellipsis">{file.split("/").pop()}</span>
              </button>
            )}
          </For>
        </Card>
      </Show>
      <Show when={change() && (change()!.add || change()!.del)}>
        <Card id="changes" title="Changes">
          <div class="cc-card-row" role="list" aria-label="Repository and pull request controls">
            <button
              class="cc-changes-open"
              role="listitem"
              aria-label={`Open changes, ${change()!.add} added, ${change()!.del} removed`}
              aria-keyshortcuts="Control+Shift+D"
              onClick={() => state.pane !== "changes" && togglePane("changes")}
            >
              <Icon name="changes" size={15} /> <span class="cc-add">+{change()!.add}</span> <span class="cc-del">−{change()!.del}</span>
            </button>
            <div class="cc-grow" />
            <button class="cc-btn" title={LOCKED} disabled>
              Commit changes
            </button>
            <button class="cc-icon-btn cc-small" aria-label={`More options for ${branch() ?? "this branch"}`} title={LOCKED} disabled>
              <Icon name="more" size={15} />
            </button>
          </div>
        </Card>
      </Show>
    </aside>
  )
}
