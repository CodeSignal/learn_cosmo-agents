// The app's actions, as the command menu's Actions tab lists them (original order and shortcuts),
// and the keyboard shortcuts that run them. An action without `run` is shown but can't be used;
// `locked` says why.
import type { IconName } from "./icons"
import { editor } from "./editor"
import {
  activeThread,
  archive,
  goHome,
  openChanges,
  openCommandMenu,
  openSettings,
  openThread,
  pin,
  showToast,
  startRename,
  state,
  threadOrder,
  toggleSidebar,
} from "./store"

const NA = "Not available in this task"

export type Action = {
  id: string
  label: string
  icon?: IconName
  shortcut?: string
  locked?: string
  /** Absent: shown but greyed out (the original has these too, e.g. Back/Forward). */
  run?: () => void
  /** Only offered when this holds (e.g. an open chat for Archive). */
  when?: () => boolean
}

const onThread = () => state.page === "thread" && !!activeThread()
const withThread = (fn: (id: string) => void) => () => {
  const thread = activeThread()
  if (thread && state.page === "thread") fn(thread.id)
}

function sidebarStep(delta: number) {
  const order = threadOrder()
  if (!order.length) return
  const at = order.findIndex((t) => t.id === state.activeId)
  const next = order[(at + delta + order.length) % order.length] ?? order[0]!
  void openThread(next.id)
}

const SETTINGS: [label: string, page: string][] = [
  ["General", "general"],
  ["Import", "import"],
  ["Appearance", "appearance"],
  ["Voice", "voice"],
  ["Storage", "storage"],
  ["Mini & Pets", "mini"],
  ["Git", "git"],
  ["Connections", "connections"],
  ["Environments", "environments"],
  ["Worktrees", "worktrees"],
  ["Configuration", "configuration"],
  ["Personalization", "personalization"],
  ["Keyboard shortcuts", "shortcuts"],
  ["Browser", "browser"],
  ["Computer use", "computer-use"],
  ["MCP servers", "plugins"],
  ["Hooks", "hooks"],
  ["Plugins", "plugins"],
  ["Archived chats", "archived"],
]

export const ACTIONS: Action[] = [
  { id: "new-chat", label: "New chat", icon: "pencil", shortcut: "Ctrl+N", run: goHome },
  { id: "open-folder", label: "Open folder", icon: "folder", shortcut: "Ctrl+O", locked: NA },
  ...SETTINGS.map(([label, page]): Action => ({ id: `settings-${label}`, label, icon: "gear", run: () => openSettings(page) })),
  { id: "standalone", label: "New standalone chat", shortcut: "Ctrl+Alt+O", locked: NA },
  { id: "new-window", label: "Open in new window", locked: NA },
  { id: "archive", label: "Archive chat", icon: "archive", shortcut: "Ctrl+Shift+A", when: onThread, run: withThread((id) => void archive(id)) },
  { id: "unread", label: "Mark as unread", shortcut: "Ctrl+Shift+U", locked: NA },
  { id: "pin", label: "Toggle pin", icon: "pin", shortcut: "Ctrl+Alt+P", when: onThread, run: withThread(pin) },
  { id: "side-chat", label: "Open side chat", shortcut: "Ctrl+Alt+S", locked: NA },
  { id: "switch-chat", label: "Switch chat…", icon: "chat", run: () => openCommandMenu("chats") },
  { id: "activity", label: "Toggle activity view", shortcut: "Ctrl+Alt+U", run: () => showToast("This part of Cosmodex isn't available yet.") },
  { id: "focus", label: "Focus main chat", shortcut: "Alt+L", run: () => editor.focus() },
  {
    id: "attention",
    label: "Next chat needing attention",
    shortcut: "Ctrl+Alt+A",
    run: () => {
      const waiting = Object.values(state.requests).map((r) => r.params?.threadId as string | undefined)
      const next = threadOrder().find((t) => waiting.includes(t.id) && t.id !== state.activeId) ?? threadOrder().find((t) => waiting.includes(t.id))
      if (next) void openThread(next.id)
      else showToast("Nothing needs attention")
    },
  },
  { id: "previous", label: "Previous sidebar item", shortcut: "Ctrl+Alt+[", run: () => sidebarStep(-1) },
  { id: "next", label: "Next sidebar item", shortcut: "Ctrl+Alt+]", run: () => sidebarStep(1) },
  ...[1, 2, 3, 4, 5, 6].map(
    (n): Action => ({
      id: `recent-${n}`,
      label: `Go to recent chat ${n}`,
      shortcut: `Ctrl+Alt+${n}`,
      run: () => {
        const thread = threadOrder()[n - 1]
        if (thread) void openThread(thread.id)
      },
    }),
  ),
  { id: "work", label: "Switch to Work", locked: NA },
  { id: "cosmodex", label: "Switch to Cosmodex" },
  { id: "find", label: "Find", shortcut: "Ctrl+F" },
  { id: "back", label: "Back", shortcut: "Ctrl+[" },
  { id: "forward", label: "Forward", shortcut: "Ctrl+]" },
  { id: "rename", label: "Rename chat", icon: "pencil", shortcut: "Ctrl+Alt+R", when: onThread, run: withThread(startRename) },
  { id: "sidebar", label: "Toggle sidebar", icon: "sidebar", shortcut: "Ctrl+Shift+S", run: toggleSidebar },
  { id: "changes", label: "Open changes", icon: "diff", shortcut: "Ctrl+Shift+G", run: () => openChanges(activeThread()?.loaded?.at(-1)?.id ?? null) },
  { id: "settings", label: "Settings", icon: "gear", shortcut: "Ctrl+,", run: () => openSettings() },
  { id: "files", label: "Search files", icon: "file", shortcut: "Ctrl+P", run: () => openCommandMenu("files") },
]

const CODES: Record<string, string> = { "[": "BracketLeft", "]": "BracketRight", ",": "Comma", "/": "Slash" }

/** Whether a key event is the shortcut "Ctrl+Alt+1" etc. Keys match by physical key (e.code),
 * since Alt changes e.key on some layouts. Ctrl also matches Cmd. */
export function matches(shortcut: string, e: KeyboardEvent) {
  const parts = shortcut.split("+")
  const key = parts.pop()!
  const mods = new Set(parts)
  if ((e.ctrlKey || e.metaKey) !== mods.has("Ctrl") || e.shiftKey !== mods.has("Shift") || e.altKey !== mods.has("Alt")) return false
  const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : CODES[key]
  return e.code === code
}

export function onShortcut(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey || e.altKey)) return
  // An open dialog (command menu, rename) handles its own keys.
  if (state.commandMenu || state.renaming) return
  const action = ACTIONS.find((a) => a.shortcut && a.run && !a.locked && (a.when?.() ?? true) && matches(a.shortcut, e))
  if (!action) return
  e.preventDefault()
  action.run!()
}
