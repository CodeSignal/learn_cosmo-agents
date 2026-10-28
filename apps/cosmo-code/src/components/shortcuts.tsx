// The keyboard shortcuts dialog (S17, Ctrl+/): the original's table, in its three groups.
import { For, Show } from "solid-js"
import { Icon } from "../icons"
import { state, toggleShortcuts } from "../store"

type Shortcut = [label: string, ...keys: string[][]]

const GROUPS: { title: string; rows: Shortcut[] }[] = [
  {
    title: "General",
    rows: [
      ["Search or start a session", ["Ctrl", "K"]],
      ["Search", ["Ctrl", "Shift", "K"]],
      ["Toggle sidebar", ["Ctrl", "B"]],
      ["Keyboard shortcuts", ["Ctrl", "/"]],
      ["Settings", ["Ctrl", ","]],
      ["Focus next page area", ["F6"]],
      ["Focus previous page area", ["Shift", "F6"]],
      ["New session", ["Ctrl", "N"]],
      ["New session with current settings", ["Ctrl", "Shift", "N"]],
      ["Select environment", ["Alt", "1…9"]],
      ["New environment", ["Alt", "0"]],
      ["Close tab, pane, or session", ["Ctrl", "W"]],
      ["Reopen closed session", ["Ctrl", "Shift", "T"]],
      ["Next session", ["Ctrl", "Shift", "]"], ["Ctrl", "Tab"]],
      ["Previous session", ["Ctrl", "Shift", "["], ["Ctrl", "Shift", "Tab"]],
      ["Jump to session", ["Ctrl", "1…9"]],
      ["Next sidebar tab", ["Ctrl", "Alt", "→"]],
      ["Previous sidebar tab", ["Ctrl", "Alt", "←"]],
      ["Archive session", ["Ctrl", "Shift", "Backspace"]],
      ["Open session in split view", ["Alt", "Click"]],
      ["New session on the right", ["Ctrl", "Alt", "\\"]],
      ["New session below", ["Ctrl", "Alt", "-"]],
      ["Focus next split view", ["Ctrl", "]"]],
      ["Focus previous split view", ["Ctrl", "["]],
      ["Close split view", ["Ctrl", "Alt", "W"]],
      ["Transcript view", ["Ctrl", "O"]],
      ["Find", ["Ctrl", "F"]],
      ["Find next", ["Ctrl", "G"], ["F3"]],
      ["Find previous", ["Ctrl", "Shift", "G"], ["Shift", "F3"]],
      ["Stop Claude’s response", ["Esc"]],
      ["Rewind the session to an earlier message", ["Esc", "then", "Esc"]],
    ],
  },
  {
    title: "Panes",
    rows: [
      ["Toggle changes", ["Ctrl", "Shift", "D"]],
      ["Toggle file list in changes or files", ["Ctrl", "Shift", "Y"]],
      ["Next change in changes", ["F7"]],
      ["Previous change in changes", ["Shift", "F7"]],
      ["Go to file in changes or files", ["Ctrl", "P"]],
      ["Toggle preview", ["Ctrl", "Shift", "P"]],
      ["Select element in preview", ["Ctrl", "Shift", "S"]],
      ["Annotate page in preview", ["Ctrl", "Shift", "X"]],
      ["Reload page in preview", ["F5"]],
      ["Toggle Files", ["Ctrl", "Shift", "F"]],
      ["Attach selection as context", ["Ctrl", "Shift", "L"]],
      ["Toggle terminal", ["Ctrl", "`"]],
      ["Close pane", ["Ctrl", "\\"]],
      ["Expand or collapse pane", ["Ctrl", "Shift", "\\"]],
      ["Toggle side chat", ["Ctrl", ";"]],
    ],
  },
  {
    title: "Composer",
    rows: [
      ["Open mode menu", ["Ctrl", "Shift", "M"]],
      ["Open model menu", ["Ctrl", "Shift", "I"]],
      ["Open effort selector", ["Ctrl", "Shift", "E"]],
      ["Select menu item", ["1…9"]],
      ["Add files or photos", ["Ctrl", "U"]],
      ["Queue for later (while Claude is working)", ["Ctrl", "Enter"]],
      ["Send and stay on the new session page", ["Ctrl", "Enter"]],
      ["Send in a forked session (local sessions)", ["Ctrl", "Alt", "Enter"]],
    ],
  },
]

export function Shortcuts() {
  return (
    <Show when={state.shortcuts}>
      <div class="cc-scrim cc-scrim-center" onMouseDown={(e) => e.target === e.currentTarget && toggleShortcuts()}>
        <div
          class="cc-shortcuts"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cc-shortcuts-title"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return
            e.preventDefault()
            e.stopPropagation()
            toggleShortcuts()
          }}
        >
          <header class="cc-shortcuts-head">
            <h2 id="cc-shortcuts-title">Keyboard shortcuts</h2>
            <button class="cc-icon-btn" aria-label="Close" ref={(el) => queueMicrotask(() => el.focus())} onClick={toggleShortcuts}>
              <Icon name="close" size={16} />
            </button>
          </header>
          <div class="cc-shortcuts-body" role="region" aria-label="Keyboard shortcuts" tabIndex={0}>
            <For each={GROUPS}>
              {(group) => (
                <section>
                  <h3>{group.title}</h3>
                  <For each={group.rows}>
                    {([label, ...combos]) => (
                      <div class="cc-shortcut">
                        <span>{label}</span>
                        <span class="cc-shortcut-keys">
                          <For each={combos}>
                            {(keys, i) => (
                              <>
                                <Show when={i() > 0}>
                                  <span class="cc-muted">or</span>
                                </Show>
                                <For each={keys}>{(k) => (k === "then" ? <span class="cc-muted">then</span> : <kbd class="cc-key">{k}</kbd>)}</For>
                              </>
                            )}
                          </For>
                        </span>
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
