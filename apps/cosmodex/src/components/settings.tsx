// Settings: replaces the sidebar with its own nav (Search; Personal, Integrations, Coding) and
// shows one page at a time, with the original's pages, sections and rows. Each row either works
// (a Cosmodex preference), shows what the engine reports, or is locked with the reason, the same
// way the composer's permissions menu shows a locked option.
import { createMemo, createResource, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { Icon } from "../icons"
import { prefs, setPref, type PrefKey } from "../prefs"
import { call } from "../engine"
import { ACTIONS } from "../actions"
import type { HookMetadata } from "../protocol/v2/HookMetadata"
import type { HooksListResponse } from "../protocol/v2/HooksListResponse"
import { archivedThreads, goHome, openSettings, state, threadOrder, unarchive } from "../store"

const TASK = "Set by this task"
const NA = "Not available in this task"
const DISABLED = "Disabled for this task"

type Control =
  | { kind: "switch"; pref?: PrefKey; value?: boolean; locked?: string }
  | { kind: "select"; options: string[]; pref?: PrefKey; value?: string; locked?: string }
  | { kind: "segmented"; options: string[]; pref?: PrefKey; value?: string; locked?: string }
  | { kind: "button"; label: string; locked?: string }
  | { kind: "value"; text: string; locked?: string }
  | { kind: "custom"; render: () => JSX.Element }
type Row = { title: string; description?: string; control: Control }
type Section = { title?: string; rows: Row[] }
type PageDef = { id: string; title: string; group: "Personal" | "Integrations" | "Coding"; intro?: string; sections: Section[]; custom?: () => JSX.Element }

function ModeControl() {
  const theme = useTheme()
  const options = [
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ] as const
  return (
    <div class="cx-segmented" role="radiogroup" aria-label="Mode">
      <For each={options}>
        {(o) => (
          <button role="radio" aria-checked={theme.colorScheme() === o.id} onClick={() => theme.setColorScheme(o.id)}>
            {o.label}
          </button>
        )}
      </For>
    </div>
  )
}

const PAGES: PageDef[] = [
  {
    id: "general",
    title: "General",
    group: "Personal",
    sections: [
      {
        title: "Permissions",
        rows: [
          { title: "Default permissions", description: "By default, Cosmodex can read and edit files in its workspace. It can ask for additional access when needed", control: { kind: "switch", value: true, locked: TASK } },
          { title: "Full access", description: "When Cosmodex runs with full access, it can edit any file on your computer and run commands with network, without your approval.", control: { kind: "switch", value: false, locked: DISABLED } },
        ],
      },
      {
        title: "General",
        rows: [
          { title: "Projectless chat folder", description: "The location where chats started outside of projects store their data by default.", control: { kind: "value", text: "—", locked: NA } },
          { title: "Default file open destination", description: "Where files and folders open by default", control: { kind: "select", options: ["Default app"], value: "Default app", locked: NA } },
          { title: "Language", description: "Language for the app UI", control: { kind: "select", options: ["Auto detect"], value: "Auto detect" } },
          { title: "Confirm before closing a window", description: "Warn when a tab-close shortcut would close the window", control: { kind: "select", options: ["Close shortcut only"], value: "Close shortcut only", locked: NA } },
          { title: "Full view by default", description: "Start new chats with Chat and content in a single tab strip", control: { kind: "switch", pref: "fullViewByDefault" } },
          { title: "Bottom panel", description: "Show the bottom panel control in the app header", control: { kind: "switch", pref: "bottomPanel" } },
          { title: "Prevent sleep while running", description: "Keep your computer awake while Cosmodex is running a task", control: { kind: "switch", value: false, locked: NA } },
          { title: "Automatically archive inactive chats", description: "Archive local chats after a period of inactivity", control: { kind: "select", options: ["Never"], value: "Never" } },
          { title: "Compress local chat history", description: "Save disk space by compressing older local chat history.", control: { kind: "switch", value: false, locked: TASK } },
          { title: "Open source licenses", description: "Third-party notices for bundled dependencies", control: { kind: "button", label: "View", locked: NA } },
        ],
      },
      { title: "Plugins", rows: [{ title: "Allow Cosmodex to use installed plugins", control: { kind: "switch", value: false, locked: DISABLED } }] },
      {
        title: "Composer",
        rows: [
          { title: "Plain text composer", description: "Keep code, Markdown, and links as literal text while writing messages", control: { kind: "switch", pref: "plainTextComposer" } },
          { title: "Show context window usage", control: { kind: "switch", pref: "showContextUsage" } },
          { title: "Send shortcut", description: "Choose when Enter sends a prompt or inserts a new line", control: { kind: "select", options: ["Enter", "Ctrl+Enter"], pref: "sendShortcut" } },
          { title: "Follow-up behavior", description: "Queue follow-ups while Cosmodex runs or steer the current run", control: { kind: "segmented", options: ["Queue", "Steer"], pref: "followUp" } },
        ],
      },
      { title: "Popout Window", rows: [{ title: "Popout Window hotkey", description: "Set a global shortcut for Popout Window. Leave unset to keep it off.", control: { kind: "select", options: ["Off"], value: "Off", locked: NA } }] },
      { rows: [{ title: "Default to standalone chat", description: "Start new chats outside of any project", control: { kind: "switch", value: false, locked: TASK } }] },
      {
        title: "Notifications",
        rows: [
          { title: "Turn completion notifications", description: "Set when Cosmodex alerts you that it's finished", control: { kind: "select", options: ["Only when unfocused"], value: "Only when unfocused", locked: NA } },
          { title: "Enable permission notifications", description: "Show alerts when notification permissions are required", control: { kind: "switch", value: false, locked: NA } },
          { title: "Enable question notifications", description: "Show alerts when input is needed to continue", control: { kind: "switch", value: false, locked: NA } },
          { title: "Notification sound", description: "Sound for task completion, permission requests, and questions", control: { kind: "select", options: ["Default"], value: "Default", locked: NA } },
        ],
      },
      { title: "Toys", rows: [{ title: "Confetti cannon", description: "Show confetti in the app when you ask!", control: { kind: "switch", pref: "confetti" } }] },
    ],
  },
  {
    id: "import",
    title: "Import",
    group: "Personal",
    intro: "Bring setup, projects, and chats from other AI apps into Cosmodex",
    sections: [
      {
        rows: [
          { title: "Automatic sync", description: "Keep imports in sync", control: { kind: "switch", value: false, locked: DISABLED } },
          { title: "Content to sync", description: "Available after your first import", control: { kind: "button", label: "Customize", locked: DISABLED } },
          { title: "Import from another AI app", description: "No importable setup found", control: { kind: "button", label: "Import", locked: DISABLED } },
        ],
      },
    ],
  },
  {
    id: "appearance",
    title: "Appearance",
    group: "Personal",
    sections: [
      {
        title: "Visual style",
        rows: [
          { title: "Mode", control: { kind: "custom", render: () => <ModeControl /> } },
          { title: "Theme", control: { kind: "select", options: ["Cosmo"], value: "Cosmo", locked: TASK } },
          { title: "Accent", control: { kind: "value", text: "Default", locked: TASK } },
          { title: "Background", control: { kind: "value", text: "Theme background", locked: TASK } },
          { title: "Foreground", control: { kind: "value", text: "Theme ink", locked: TASK } },
          { title: "Font", control: { kind: "value", text: "Work Sans", locked: TASK } },
        ],
      },
    ],
  },
  { id: "archived", title: "Archived chats", group: "Personal", sections: [], custom: () => <ArchivedChats /> },
  {
    id: "voice",
    title: "Voice",
    group: "Personal",
    sections: [
      {
        rows: [
          { title: "Voice chat", description: "Voice chat unavailable", control: { kind: "value", text: "", locked: NA } },
          { title: "Dictation", description: "Dictation unavailable", control: { kind: "value", text: "", locked: NA } },
        ],
      },
    ],
  },
  { id: "storage", title: "Storage", group: "Personal", sections: [], custom: () => <Storage /> },
  { id: "configuration", title: "Configuration", group: "Personal", intro: "Configure permissions, web access, and agent responses for new chats", sections: [], custom: () => <Configuration /> },
  {
    id: "personalization",
    title: "Personalization",
    group: "Personal",
    sections: [
      {
        title: "Codex memory",
        rows: [
          { title: "Enable Codex memories", description: "Create memories from chats and use them to personalize future chats", control: { kind: "switch", value: false, locked: TASK } },
          { title: "Allow memories from tool-assisted chats", description: "Generate memories from chats that used MCP tools or web search", control: { kind: "switch", value: false, locked: TASK } },
          { title: "Delete Codex memories", control: { kind: "button", label: "Delete", locked: TASK } },
        ],
      },
      { title: "Custom instructions", rows: [{ title: "Codex instructions", description: "The instructions for this task are set by the task. Repository instructions may also apply.", control: { kind: "button", label: "Edit", locked: TASK } }] },
    ],
  },
  {
    id: "mini",
    title: "Mini & Pets",
    group: "Personal",
    sections: [{ rows: [{ title: "Show mini", control: { kind: "switch", value: false, locked: NA } }, { title: "My pets", control: { kind: "button", label: "Create pet", locked: NA } }] }],
  },
  { id: "shortcuts", title: "Keyboard shortcuts", group: "Personal", sections: [], custom: () => <Shortcuts /> },
  { id: "plugins", title: "Plugins", group: "Integrations", intro: "Manage plugins, skills, and MCPs", sections: [], custom: () => <Plugins /> },
  {
    id: "computer-use",
    title: "Computer use",
    group: "Integrations",
    intro: "Manage how Cosmodex uses other applications on your computer",
    sections: [{ title: "Control", rows: [{ title: "Google Chrome", control: { kind: "switch", value: false, locked: DISABLED } }] }],
  },
  {
    id: "browser",
    title: "Browser",
    group: "Integrations",
    intro: "Manage your Browser Use preferences and site access.",
    sections: [
      { rows: [{ title: "Browser", control: { kind: "switch", value: false, locked: DISABLED } }] },
      {
        title: "General",
        rows: [
          { title: "Web URL and link open destination", control: { kind: "select", options: ["Cosmodex"], value: "Cosmodex", locked: NA } },
          { title: "Show full URL", description: "Include the path, query, and fragment in the address bar", control: { kind: "switch", value: false, locked: NA } },
        ],
      },
      { title: "Browsing data", rows: [{ title: "Clear browsing data", control: { kind: "button", label: "Clear", locked: NA } }] },
    ],
  },
  { id: "hooks", title: "Hooks", group: "Coding", intro: "Manage lifecycle hooks from config and enabled plugins.", sections: [], custom: () => <Hooks /> },
  {
    id: "connections",
    title: "Connections",
    group: "Coding",
    sections: [{ rows: [{ title: "SSH connections from this PC", description: "Connect to a remote device through SSH connection", control: { kind: "button", label: "Add", locked: DISABLED } }] }],
  },
  {
    id: "git",
    title: "Git",
    group: "Coding",
    sections: [
      {
        rows: [
          { title: "Branch prefix", description: "Prefix used when Cosmodex creates new branches", control: { kind: "value", text: "codex/", locked: NA } },
          { title: "Pull request merge method", description: "Choose how Cosmodex merges pull requests", control: { kind: "segmented", options: ["Merge", "Squash"], value: "Merge", locked: NA } },
          { title: "Always force push", description: "Use --force-with-lease when pushing from Cosmodex", control: { kind: "switch", value: false, locked: NA } },
          { title: "Create draft pull requests", description: "Use draft pull requests by default when creating PRs from Cosmodex", control: { kind: "switch", value: false, locked: NA } },
          { title: "Review delivery", description: "Start /review in the current chat when possible or launch a separate review chat", control: { kind: "segmented", options: ["Inline", "Detached"], value: "Inline", locked: NA } },
          { title: "Commit instructions", description: "Added to commit message generation prompts", control: { kind: "button", label: "Edit", locked: NA } },
          { title: "Pull request instructions", description: "Added to PR title/description generation prompts", control: { kind: "button", label: "Edit", locked: NA } },
        ],
      },
    ],
  },
  {
    id: "environments",
    title: "Environments",
    group: "Coding",
    intro: "Local environments tell Cosmodex how to set up worktrees for a project.",
    sections: [{ rows: [{ title: "Select a project", control: { kind: "button", label: "Add project", locked: DISABLED } }] }],
  },
  {
    id: "worktrees",
    title: "Worktrees",
    group: "Coding",
    sections: [
      {
        title: "Creation and cleanup",
        rows: [
          { title: "Worktree root", description: "Leave blank to use the default location", control: { kind: "value", text: "", locked: DISABLED } },
          { title: "Always fetch upstream before creating worktrees", control: { kind: "switch", value: false, locked: DISABLED } },
          { title: "Automatically delete old worktrees", description: "Saves a recovery snapshot first", control: { kind: "switch", value: false, locked: DISABLED } },
          { title: "Worktrees to keep", description: "No worktrees yet", control: { kind: "value", text: "—", locked: DISABLED } },
        ],
      },
    ],
  },
]

function ControlView(props: { control: Control; label?: string }) {
  const c = props.control
  const current = () => ("pref" in c && c.pref ? (prefs[c.pref] as unknown) : "value" in c ? c.value : undefined)
  const set = (v: unknown) => "pref" in c && c.pref && setPref(c.pref, v as never)
  return (
    <div class="cx-control" data-locked={"locked" in c && c.locked ? "" : undefined}>
      <Switch>
        <Match when={c.kind === "switch" && c}>
          {(sw) => (
            <button role="switch" class="cx-switch" aria-label={props.label} aria-checked={!!current()} disabled={!!sw().locked} onClick={() => set(!current())}>
              <span class="cx-switch-knob" />
            </button>
          )}
        </Match>
        <Match when={c.kind === "select" && c}>
          {(sel) => (
            <select class="cx-select" aria-label={props.label} disabled={!!sel().locked || sel().options.length < 2} value={String(current() ?? sel().options[0])} onChange={(e) => set(e.currentTarget.value)}>
              <For each={sel().options}>{(o) => <option value={o}>{o}</option>}</For>
            </select>
          )}
        </Match>
        <Match when={c.kind === "segmented" && c}>
          {(seg) => (
            <div class="cx-segmented" role="radiogroup" aria-label={props.label}>
              <For each={seg().options}>
                {(o) => (
                  <button role="radio" aria-checked={current() === o} disabled={!!seg().locked} onClick={() => set(o)}>
                    {o}
                  </button>
                )}
              </For>
            </div>
          )}
        </Match>
        <Match when={c.kind === "button" && c}>{(b) => <button class="cx-btn cx-small-btn" disabled={!!b().locked}>{b().label}</button>}</Match>
        <Match when={c.kind === "value" && c}>{(v) => <span class="cx-setting-value">{v().text}</span>}</Match>
        <Match when={c.kind === "custom" && c}>{(cu) => cu().render()}</Match>
      </Switch>
      <Show when={"locked" in c && c.locked}>
        <span class="cx-lock-note">
          <Icon name="lock" size={12} /> {(c as { locked: string }).locked}
        </span>
      </Show>
    </div>
  )
}

function SectionView(props: { section: Section; filter: string }) {
  const rows = () => props.section.rows.filter((r) => !props.filter || `${r.title} ${r.description ?? ""}`.toLowerCase().includes(props.filter))
  return (
    <Show when={rows().length}>
      <section class="cx-settings-section">
        <Show when={props.section.title}>
          <h3 class="cx-settings-section-title">{props.section.title}</h3>
        </Show>
        <div class="cx-settings-card">
          <For each={rows()}>
            {(row) => (
              <div class="cx-setting-row">
                <div class="cx-setting-text">
                  <div class="cx-setting-title">{row.title}</div>
                  <Show when={row.description}>
                    <div class="cx-menu-subtitle">{row.description}</div>
                  </Show>
                </div>
                <ControlView control={row.control} label={row.title} />
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}

function ArchivedChats() {
  const [list, { refetch }] = createResource(archivedThreads)
  return (
    <div class="cx-settings-card">
      <For each={list() ?? []} fallback={<div class="cx-empty-row">No archived chats</div>}>
        {(thread) => (
          <div class="cx-setting-row">
            <div class="cx-setting-title">{thread.name || thread.preview || "Chat"}</div>
            <button class="cx-btn cx-small-btn" onClick={() => void unarchive(thread.id).then(refetch)}>
              Restore
            </button>
          </div>
        )}
      </For>
    </div>
  )
}

function Storage() {
  const [archived] = createResource(archivedThreads)
  return (
    <div class="cx-settings-card">
      <div class="cx-setting-row">
        <div class="cx-setting-title">Chats</div>
        <span class="cx-setting-value">{threadOrder().length}</span>
      </div>
      <div class="cx-setting-row">
        <div class="cx-setting-title">Archived chats</div>
        <span class="cx-setting-value">{archived()?.length ?? "…"}</span>
      </div>
      <div class="cx-setting-row">
        <div class="cx-setting-text">
          <div class="cx-setting-title">Clean up old chats</div>
          <div class="cx-menu-subtitle">Review chats and their subagents before permanently deleting them</div>
        </div>
        <ControlView control={{ kind: "button", label: "Review", locked: TASK }} />
      </div>
    </div>
  )
}

// The task's requirements a candidate would recognise; plumbing (providers, catalog, login) stays out.
const REQUIREMENTS: [key: string, label: string][] = [
  ["allowedApprovalPolicies", "Approval policy"],
  ["allowedSandboxModes", "Sandbox settings"],
  ["allowedWebSearchModes", "Web search"],
  ["allowManagedHooksOnly", "Managed hooks only"],
  ["allowBrowserAndComputerUse", "Browser and computer use"],
  ["allowRemoteControl", "Remote control"],
]

/** Like the original: the engine's own warnings about managed values, then the values the task sets. */
function Configuration() {
  const [requirements] = createResource(() => call<{ requirements: Record<string, unknown> | null }>("configRequirements/read", {}).catch(() => null))
  const managed = createMemo(() => REQUIREMENTS.filter(([key]) => requirements()?.requirements?.[key] != null))
  // "on-request" → "On request", as the original labels them.
  const word = (v: unknown) => String(v).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())
  const show = (v: unknown) => (Array.isArray(v) ? v.map(word).join(", ") : typeof v === "boolean" ? (v ? "On" : "Off") : word(v))
  return (
    <>
      <h3 class="cx-settings-section-title">Agent defaults</h3>
      <For each={state.configWarnings}>
        {(w) => (
          <div class="cx-warning">
            <Icon name="lock" size={14} /> <span>{w}</span>
          </div>
        )}
      </For>
      <div class="cx-settings-card">
        <For each={managed()} fallback={<div class="cx-empty-row">{requirements.loading ? "Loading…" : "Nothing is set by this task"}</div>}>
          {([key, label]) => (
            <div class="cx-setting-row">
              <div class="cx-setting-title">{label}</div>
              <div class="cx-control" data-locked="">
                <span class="cx-setting-value">{show(requirements()!.requirements![key])}</span>
                <span class="cx-lock-note">
                  <Icon name="lock" size={12} /> {TASK}
                </span>
              </div>
            </div>
          )}
        </For>
      </div>
    </>
  )
}

// The actions' shortcuts, then the composer's and approval cards' keys.
const SHORTCUTS: [action: string, keys: string][] = [
  ...ACTIONS.filter((a) => a.shortcut).map((a): [string, string] => [a.label, a.shortcut!]),
  ["Send message", "Enter"],
  ["New line", "Shift+Enter"],
  ["Commands", "/"],
  ["Add files", "@"],
  ["Allow once", "Enter"],
  ["Deny", "Esc"],
]

function Shortcuts() {
  const [q, setQ] = createSignal("")
  return (
    <>
      <input class="cx-other-input" placeholder="Search keyboard shortcuts" value={q()} onInput={(e) => setQ(e.currentTarget.value.toLowerCase())} />
      <div class="cx-settings-card">
        <For each={SHORTCUTS.filter(([a, k]) => `${a} ${k}`.toLowerCase().includes(q()))}>
          {([action, keys]) => (
            <div class="cx-setting-row">
              <div class="cx-setting-title">{action}</div>
              <kbd class="cx-menu-kbd">{keys}</kbd>
            </div>
          )}
        </For>
      </div>
      <p class="cx-menu-subtitle">Rebinding shortcuts isn't available in this task.</p>
    </>
  )
}

function Plugins() {
  const [servers] = createResource(() => call<{ data: { name: string }[] }>("mcpServerStatus/list", {}).catch(() => ({ data: [] })))
  return (
    <>
      <div class="cx-setting-row cx-plain">
        <ControlView control={{ kind: "button", label: "Browse directory", locked: DISABLED }} />
        <ControlView control={{ kind: "button", label: "Add", locked: DISABLED }} />
      </div>
      <h3 class="cx-settings-section-title">Servers</h3>
      <div class="cx-settings-card">
        <For each={servers()?.data ?? []} fallback={<div class="cx-empty-row">No MCP servers connected</div>}>
          {(s) => (
            <div class="cx-setting-row">
              <div class="cx-setting-title">{s.name}</div>
            </div>
          )}
        </For>
      </div>
    </>
  )
}

function Hooks() {
  const [hooks] = createResource(() =>
    call<HooksListResponse>("hooks/list", {})
      .then((res) => res.data.flatMap((entry) => entry.hooks))
      .catch(() => [] as HookMetadata[]),
  )
  return (
    <div class="cx-settings-card">
      <For each={hooks() ?? []} fallback={<div class="cx-empty-row">No hooks found · Configured hooks will appear here</div>}>
        {(hook) => (
          <div class="cx-setting-row">
            <div class="cx-setting-text">
              <div class="cx-setting-title">{hook.eventName}</div>
              <div class="cx-menu-subtitle">{"command" in hook ? hook.command : hook.handlerType}</div>
            </div>
            <ControlView control={{ kind: "switch", value: hook.enabled, locked: hook.isManaged ? TASK : NA }} label={hook.eventName} />
          </div>
        )}
      </For>
    </div>
  )
}

export function SettingsNav() {
  const [q, setQ] = createSignal("")
  const groups = ["Personal", "Integrations", "Coding"] as const
  return (
    <aside class="cx-sidebar" aria-label="Settings">
      <button class="cx-sidebar-action" onClick={goHome}>
        <Icon name="chevronLeft" /> Back to app
      </button>
      <input class="cx-other-input cx-settings-search" placeholder="Search" value={q()} onInput={(e) => setQ(e.currentTarget.value.toLowerCase())} />
      <For each={groups}>
        {(group) => (
          <section class="cx-section">
            <div class="cx-section-head">{group}</div>
            <For each={PAGES.filter((p) => p.group === group && (!q() || p.title.toLowerCase().includes(q()) || p.sections.some((s) => s.rows.some((r) => r.title.toLowerCase().includes(q())))))}>
              {(page) => (
                <button class="cx-thread-row" data-active={state.settingsPage === page.id ? "" : undefined} onClick={() => openSettings(page.id)}>
                  {page.title}
                </button>
              )}
            </For>
          </section>
        )}
      </For>
    </aside>
  )
}

export function SettingsPage() {
  const page = () => PAGES.find((p) => p.id === state.settingsPage) ?? PAGES[0]!
  return (
    <div class="cx-settings">
      <h1 class="cx-page-title">{page().title}</h1>
      <Show when={page().intro}>
        <p class="cx-page-empty">{page().intro}</p>
      </Show>
      <Show when={page().custom}>{page().custom!()}</Show>
      <For each={page().sections}>{(section) => <SectionView section={section} filter="" />}</For>
    </div>
  )
}
