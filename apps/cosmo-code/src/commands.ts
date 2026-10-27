// The slash menu's commands, as the original lists them: its own commands first (plugin … agents),
// then the engine's, alphabetically. The app's own commands act in the UI (menus, modes, the
// palette); the engine's go to the engine as the prompt ("/compact"), which runs them. Commands a
// task can't offer are locked; the ones whose screens aren't built yet say so.
import {
  activeSession,
  configure,
  newSession,
  openMenu,
  openPalette,
  rename,
  send,
  setRenamingTitle,
  showToast,
  state,
  type Command,
} from "./store"

const LOCKED = "Not available in this task"
const soon = () => showToast("This part of Cosmo Code isn't available yet.")

export type SlashCommand = Command & {
  /** Runs it; `args` is what follows the name. Absent: the engine runs it. */
  run?: (args: string) => void
  locked?: string
}

const APP: SlashCommand[] = [
  { name: "plugin", description: "Manage plugins", locked: LOCKED },
  { name: "model", description: "Set the model for this session", run: () => openMenu("model") },
  { name: "effort", description: "Set the effort level for this session", run: () => openMenu("model") },
  { name: "plan", description: "Switch to plan mode or view this session's plan", run: () => void configure({ mode: "plan" }) },
  { name: "permissions", description: "Change the permission mode", run: () => openMenu("mode") },
  { name: "skills", description: "Browse and manage your skills", locked: LOCKED },
  { name: "workflows", description: "Browse workflow history (running and completed)", locked: LOCKED },
  { name: "usage", description: "Show plan usage and rate limits", run: () => openMenu("usage") },
  { name: "config", description: "Open settings", run: soon },
  { name: "storage", description: "See how much space sessions use on this computer", run: soon },
  { name: "sandbox", description: "Open sandbox settings", locked: LOCKED },
  { name: "theme", description: "Set the appearance (system, light, or dark)", run: soon },
  { name: "resume", description: "Search and continue a session from this computer", run: () => openPalette("recents") },
  { name: "help", description: "Get help and support", run: soon },
  { name: "agents", description: "(removed) Ask Claude to create/manage subagents, or edit .claude/agents/" },
]

// Handled by the app (above, or here); never sent to the engine under the same name.
const LOCAL: Record<string, SlashCommand["run"]> = {
  clear: () => newSession(),
  rename: (args) => {
    const s = activeSession()
    if (!s) return
    if (args.trim()) void rename(s.id, args)
    else setRenamingTitle(true)
  },
}
// Engine commands that don't apply here: internal ones, auto mode and fast mode (off by policy).
const HIDDEN = new Set(["__remote-workflow", "workflow-launch-exec", "auto-mode-setup", "fast"])

export function slashCommands(): SlashCommand[] {
  const app = new Set(APP.map((c) => c.name))
  const engine = (state.info?.commands ?? [])
    .filter((c) => !app.has(c.name) && !HIDDEN.has(c.name) && !c.name.startsWith("__"))
    .map((c): SlashCommand => {
      if (c.name === "mcp") return { ...c, locked: LOCKED }
      if (c.name in LOCAL) return { ...c, run: LOCAL[c.name] }
      return c
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...APP, ...engine]
}

/** Run a command typed or picked in the composer ("/name args"). */
export function runSlash(command: SlashCommand, args = "") {
  if (command.locked) return showToast(`/${command.name}: ${command.locked}`)
  if (command.run) return command.run(args)
  void send(`/${command.name}${args.trim() ? ` ${args.trim()}` : ""}`)
}
