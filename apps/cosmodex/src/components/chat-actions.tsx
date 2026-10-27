// The thread "…" menu (Chat actions) and the Rename dialog, as in the original:
// Rename · Pin · New side chat · Fork ▸ · Add scheduled task… · Copy ▸ · Move to right pane ·
// Open in new window · Archive.
import { createSignal, onMount, Show } from "solid-js"
import { Icon } from "../icons"
import { MenuList, Popover, type MenuItem } from "./popover"
import { prefs } from "../prefs"
import { archive, copy, fork, pin, rename, startRename, state, threadMarkdown, threadTitle, type ThreadView } from "../store"

const LOCKED = "Not available in this task"

export function chatActions(thread: ThreadView): MenuItem[] {
  const pinned = prefs.pinned.includes(thread.id)
  return [
    { label: "Rename", shortcut: "Ctrl+Alt+R", onSelect: () => startRename(thread.id) },
    { label: pinned ? "Unpin" : "Pin", shortcut: "Ctrl+Alt+P", onSelect: () => pin(thread.id) },
    { label: "New side chat", shortcut: "Ctrl+Alt+S", locked: LOCKED },
    { separator: true },
    { heading: "Fork" },
    { label: "Fork chat", onSelect: () => void fork(thread.id) },
    { label: "Fork into new worktree", locked: LOCKED },
    { label: "Add scheduled task…", locked: LOCKED },
    { separator: true },
    { heading: "Copy" },
    { label: "Copy as Markdown", onSelect: () => void copy(threadMarkdown(thread), "Chat") },
    { label: "Copy chat ID", onSelect: () => void copy(thread.id, "Chat ID") },
    { separator: true },
    { label: "Move to right pane", disabled: true },
    { label: "Open in new window", locked: LOCKED },
    { label: "Archive", shortcut: "Ctrl+Shift+A", onSelect: () => void archive(thread.id) },
  ]
}

export function ChatActionsMenu(props: { thread: ThreadView }) {
  return (
    <Popover
      align="end"
      class="cx-wide-menu"
      trigger={(_, toggle) => (
        <button class="cx-icon-btn" aria-label="Chat actions" onClick={toggle}>
          <Icon name="more" />
        </button>
      )}
    >
      {(close) => <MenuList close={close} items={chatActions(props.thread)} />}
    </Popover>
  )
}

export function RenameDialog() {
  const thread = () => (state.renaming ? state.threads[state.renaming] : undefined)
  return (
    <Show when={thread()}>
      {(t) => {
        const [name, setName] = createSignal(threadTitle(t()))
        let input!: HTMLInputElement
        onMount(() => {
          input.focus()
          input.select()
        })
        return (
          <div class="cx-scrim" onMouseDown={(e) => e.target === e.currentTarget && void rename(t().id, "")}>
            <form
              class="cx-dialog"
              role="dialog"
              aria-label="Rename chat"
              onSubmit={(e) => {
                e.preventDefault()
                void rename(t().id, name())
              }}
              onKeyDown={(e) => e.key === "Escape" && void rename(t().id, "")}
            >
              <h2 class="cx-dialog-title">Rename chat</h2>
              <input class="cx-other-input" ref={input} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
              <div class="cx-approval-actions">
                <button type="button" class="cx-btn" onClick={() => void rename(t().id, "")}>
                  Cancel
                </button>
                <button type="submit" class="cx-btn cx-primary">
                  Rename
                </button>
              </div>
            </form>
          </div>
        )
      }}
    </Show>
  )
}
