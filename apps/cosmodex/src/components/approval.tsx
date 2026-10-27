// Approval prompts replace the composer: "Terminal" for commands, "Edit files" for patches.
// Deny (Esc) · Allow once (Enter, focused) · Approval options ▸ (allow similar / all edits).
import { onMount, Show } from "solid-js"
import { Icon } from "../icons"
import { MenuList, Popover } from "./popover"
import { answer, WORKSPACE } from "../store"
import type { EngineMessage } from "../engine"

const MODERN = { deny: "decline", once: "accept", session: "acceptForSession" }
const LEGACY = { deny: "denied", once: "approved", session: "approved_for_session" }

export function ApprovalCard(props: { request: EngineMessage }) {
  const p = () => props.request.params ?? {}
  const id = () => String(props.request.id)
  const isEdit = () => /fileChange|applyPatch/.test(props.request.method)
  const words = () => (/^item\//.test(props.request.method) ? MODERN : LEGACY)
  const command = () => {
    const c = p().command
    return Array.isArray(c) ? c.join(" ") : (c ?? "")
  }
  let allow!: HTMLButtonElement
  onMount(() => allow?.focus())
  return (
    <div
      class="cx-approval"
      role="dialog"
      aria-label={isEdit() ? "Edit files" : "Terminal"}
      onKeyDown={(e) => {
        if (e.key === "Escape") void answer(id(), words().deny)
      }}
    >
      <div class="cx-approval-kind">
        <Icon name={isEdit() ? "fileEdit" : "terminal"} /> {isEdit() ? "Edit files" : "Terminal"}
      </div>
      <Show when={p().reason}>
        <p class="cx-approval-reason">{p().reason}</p>
      </Show>
      <Show when={isEdit()} fallback={<pre class="cx-approval-command">{command()}</pre>}>
        <p class="cx-approval-reason">Allow Cosmodex to edit the following file?</p>
        <div class="cx-approval-file">{p().grantRoot ?? WORKSPACE}</div>
      </Show>
      <div class="cx-approval-actions">
        <button class="cx-btn" onClick={() => void answer(id(), words().deny)}>
          Deny <kbd>Esc</kbd>
        </button>
        <div class="cx-split">
          <button class="cx-btn cx-primary" ref={allow} onClick={() => void answer(id(), words().once)}>
            Allow once <kbd>⏎</kbd>
          </button>
          <Popover
            placement="above"
            align="end"
            trigger={(_, toggle) => (
              <button class="cx-btn cx-primary cx-split-arrow" aria-label="Approval options" onClick={toggle}>
                <Icon name="chevronDown" size={14} />
              </button>
            )}
          >
            {(close) => (
              <MenuList
                close={close}
                items={[
                  { label: "Allow once", onSelect: () => void answer(id(), words().once) },
                  { label: isEdit() ? "Allow all edits" : "Allow similar commands", onSelect: () => void answer(id(), words().session) },
                ]}
              />
            )}
          </Popover>
        </div>
      </div>
    </div>
  )
}
