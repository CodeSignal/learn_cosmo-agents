// The tabs pane with its Changes tab (diff review). Scope menu: Last Turn, Uncommitted, Unstaged,
// Staged, with +/- totals; options (word wrap); per file a header with path, +/- and file actions,
// then the unified diff with old/new line numbers. As in the original there's no per-hunk accept or
// reject: the turn's Undo is the revert.
import { createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "../icons"
import { MenuList, Popover } from "./popover"
import { parseDiff, totals, type DiffFile } from "../diff"
import { activeThread, closeTabs, setChangesScope, showToast, state, toggleWrap, turnDiff, type ChangesScope } from "../store"

const SCOPES: { id: ChangesScope; label: string }[] = [
  { id: "lastTurn", label: "Last Turn" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "unstaged", label: "Unstaged" },
  { id: "staged", label: "Staged" },
]

async function workspaceDiff(scope: ChangesScope): Promise<string> {
  const res = await fetch(`/api/workspace/diff?scope=${scope}`)
  const body = await res.json()
  return body.available === false ? "" : (body.diff ?? "")
}

function FileDiff(props: { file: DiffFile }) {
  const [collapsed, setCollapsed] = createSignal(false)
  return (
    <section class="cx-diff-file">
      <header class="cx-diff-file-head">
        <Icon name="fileEdit" size={14} />
        <span class="cx-diff-path">{props.file.path}</span>
        <span class="cx-add">+{props.file.add}</span>
        <span class="cx-del">-{props.file.del}</span>
        <div class="cx-grow" />
        <Popover
          align="end"
          trigger={(_, toggle) => (
            <button class="cx-icon-btn cx-small" aria-label="File actions" onClick={toggle}>
              <Icon name="more" size={14} />
            </button>
          )}
        >
          {(close) => (
            <MenuList
              close={close}
              items={[
                { label: "Copy path", onSelect: () => void navigator.clipboard.writeText(props.file.path).then(() => showToast("Path copied")) },
                { label: collapsed() ? "Expand file" : "Collapse file", onSelect: () => setCollapsed((v) => !v) },
              ]}
            />
          )}
        </Popover>
      </header>
      <Show when={!collapsed()}>
        <table class="cx-diff-table" data-wrap={state.tabs.wrap ? "" : undefined}>
          <tbody>
            <For each={props.file.lines}>
              {(line) => (
                <tr data-kind={line.kind}>
                  <td class="cx-diff-no">{line.oldNo ?? ""}</td>
                  <td class="cx-diff-no">{line.newNo ?? ""}</td>
                  <td class="cx-diff-code">{line.kind === "hunk" ? line.text : `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </section>
  )
}

export function ChangesPane() {
  const [workspace] = createResource(
    () => (state.tabs.scope === "lastTurn" ? null : { scope: state.tabs.scope, refresh: state.tabs.refresh }),
    (key) => workspaceDiff(key.scope),
  )
  const lastTurn = () => {
    const turns = activeThread()?.loaded ?? []
    return turns.find((t) => t.id === state.tabs.turnId) ?? turns.findLast((t) => t.items.some((i) => i.type === "fileChange"))
  }
  const text = () => (state.tabs.scope === "lastTurn" ? (lastTurn() ? turnDiff(lastTurn()!) : "") : (workspace() ?? ""))
  const files = () => parseDiff(text())
  const sum = () => totals(files())
  const label = () => SCOPES.find((s) => s.id === state.tabs.scope)!.label
  return (
    <aside class="cx-tabs" aria-label="Tabs">
      <div class="cx-tab-strip" role="tablist">
        <button class="cx-tab" role="tab" aria-selected="true">
          Changes
        </button>
        <div class="cx-grow" />
        <button class="cx-icon-btn" aria-label="Hide tabs" onClick={closeTabs}>
          <Icon name="sidebar" />
        </button>
      </div>
      <div class="cx-changes-toolbar">
        <Popover
          trigger={(_, toggle) => (
            <button class="cx-chip" aria-label="Diff scope" onClick={toggle}>
              {label()} <span class="cx-add">+{sum().add}</span> <span class="cx-del">-{sum().del}</span> <Icon name="chevronDown" size={12} />
            </button>
          )}
        >
          {(close) => (
            <MenuList
              close={close}
              items={[
                ...SCOPES.map((s) => ({ label: s.label, checked: state.tabs.scope === s.id, onSelect: () => setChangesScope(s.id) })),
                { label: "Committed", locked: "Not available in this task" },
                { label: "Branch", locked: "Not available in this task" },
              ]}
            />
          )}
        </Popover>
        <div class="cx-grow" />
        <Popover
          align="end"
          trigger={(_, toggle) => (
            <button class="cx-icon-btn" aria-label="Changes options" onClick={toggle}>
              <Icon name="more" />
            </button>
          )}
        >
          {(close) => <MenuList close={close} items={[{ label: "Word wrap", checked: state.tabs.wrap, onSelect: toggleWrap }]} />}
        </Popover>
      </div>
      <div class="cx-changes-body">
        <Show when={!workspace.loading} fallback={<div class="cx-loading">Loading…</div>}>
          <For each={files()} fallback={<div class="cx-empty-row">No changes</div>}>
            {(file) => <FileDiff file={file} />}
          </For>
        </Show>
      </div>
    </aside>
  )
}
