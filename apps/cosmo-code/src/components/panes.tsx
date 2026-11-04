// The right column's panes. Each has the original's frame: its own controls, then Open in new window
// (not here), Expand (Ctrl+Shift+\) and Close (Ctrl+\).
// · Plan: the proposed plan.
// · Background tasks (S32, S34c): the session's subagents and background commands; a subagent opens
//   to its conversation (‹ back to the list).
// · Preview (S40): workspace files (pages, images, PDFs, media), sandboxed. Browsing websites and
//   dev servers need network the task's sandbox doesn't have.
// · Changes (S25): the workspace's diff — "main → working tree" (All changes vs main, or
//   Uncommitted changes) — one block per file with Open file; the file list on the side.
// · Files (S39): the file tree with a filter, and the files you open, read-only.
// · Terminal (S38): shells in the workspace (only when the task has a terminal), in tabs.
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import type { FitAddon, Terminal } from "ghostty-web"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { Icon } from "../icons"
import { MenuList, Popover } from "./popover"
import { COSMO, call } from "../engine"
import { parseDiff, totals, type DiffFile } from "../diff"
import { tasksOf, type BackgroundTask } from "../tasks"
import { SubagentMessages } from "./transcript"
import { modelName } from "./composer"
import { prefs, setPref } from "../prefs"
import {
  activeSession,
  clearTasks,
  closeFile,
  closePane,
  closeSubagent,
  copy,
  FOLDER,
  onTerminal,
  openFileInPane,
  openPreview,
  openSubagent,
  previewable,
  reloadPreview,
  state,
  stepPreview,
  toggleExpanded,
  type RawMessage,
} from "../store"

const LOCKED = "Not available in this task"

function PaneFrame(props: { label: string; head: JSX.Element; children: JSX.Element; hidden?: boolean }) {
  return (
    <aside class="cc-pane" data-expanded={state.paneExpanded ? "" : undefined} aria-label={props.label} hidden={props.hidden}>
      <header class="cc-pane-head">
        {props.head}
        <div class="cc-grow" />
        <button class="cc-icon-btn cc-small" aria-label="Open in new window" title={LOCKED} disabled>
          <Icon name="external" size={15} />
        </button>
        <button class="cc-icon-btn cc-small" aria-label={state.paneExpanded ? "Collapse" : "Expand"} aria-keyshortcuts="Control+Shift+\" onClick={toggleExpanded}>
          <Icon name={state.paneExpanded ? "collapse" : "expand"} size={15} />
        </button>
        <button class="cc-icon-btn cc-small" aria-label="Close" aria-keyshortcuts="Control+\" onClick={closePane}>
          <Icon name="close" size={15} />
        </button>
      </header>
      {props.children}
    </aside>
  )
}

export function PlanPane() {
  return (
    <PaneFrame
      label="Plan"
      head={
        <>
          <span class="cc-pane-title">Plan</span>
          <button class="cc-icon-btn cc-small" aria-label="Copy plan" onClick={() => void copy(state.plan ?? "", "Plan")}>
            <Icon name="copy" size={15} />
          </button>
        </>
      }
    >
      <Show
        when={state.plan}
        fallback={
          <div class="cc-pane-empty">
            <strong>No plan yet</strong>
            <span>In plan mode, the plan Claude proposes shows here.</span>
          </div>
        }
      >
        {(plan) => (
          <div class="cc-pane-body">
            <Markdown class="cc-markdown" text={plan()} />
          </div>
        )}
      </Show>
    </PaneFrame>
  )
}

const STATUS_LABEL = { running: "Running", completed: "Completed", failed: "Failed", stopped: "Stopped" } as const

export function TasksPane() {
  const tasks = createMemo(() => {
    const s = activeSession()
    return s ? tasksOf(s).filter((t) => !state.clearedTasks[t.id]) : []
  })
  const finished = () => tasks().filter((t) => t.status !== "running")
  const open = () => (state.subagent ? tasks().find((t) => t.toolUseId === state.subagent) ?? tasksOf(activeSession()!).find((t) => t.toolUseId === state.subagent) : undefined)
  return (
    <Show
      when={open()}
      fallback={
        <PaneFrame
          label="Background tasks"
          head={
            <>
              <span class="cc-pane-title">Background tasks</span>
              <button class="cc-icon-btn cc-small" aria-label="Clear finished tasks" title="Clear finished tasks" disabled={!finished().length} onClick={() => clearTasks(finished().map((t) => t.id))}>
                <Icon name="list" size={15} />
              </button>
            </>
          }
        >
          <Show when={tasks().length} fallback={<p class="cc-pane-empty">Background tasks appear here</p>}>
            <ul class="cc-task-list">
              <For each={tasks()}>
                {(task) => (
                  <li>
                    <button class="cc-task-row" disabled={task.kind !== "agent" || !task.toolUseId} onClick={() => openSubagent(task.toolUseId!)}>
                      <Show when={task.status === "running"} fallback={<Icon name={task.kind === "shell" ? "terminal" : "fork"} size={15} />}>
                        <span class="cc-dots" aria-hidden="true" />
                      </Show>
                      <span class="cc-task-text">
                        <span class="cc-ellipsis">{task.description}</span>
                        <span class="cc-muted cc-ellipsis">{(task.status === "running" && task.summary) || task.subagentType || (task.kind === "shell" ? "Background command" : "")}</span>
                      </span>
                      <span class="cc-task-status" data-status={task.status}>
                        {STATUS_LABEL[task.status]}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </PaneFrame>
      }
    >
      {(task) => <SubagentView task={task()} />}
    </Show>
  )
}

/** A subagent's conversation: its prompt, the model it ran on, and what it did. Live messages come
 * with the session; otherwise its transcript is read from the engine. */
function SubagentView(props: { task: BackgroundTask }) {
  const live = createMemo(() => (activeSession()?.messages ?? []).filter((m) => m.parent_tool_use_id === props.task.toolUseId))
  const [stored] = createResource(
    () => (live().length ? null : { sessionId: state.activeId, agentId: props.task.id, status: props.task.status }),
    (k) =>
      call<{ messages: RawMessage[] }>("session/subagent", { sessionId: k.sessionId, agentId: k.agentId })
        .then((r) => r.messages)
        .catch(() => [] as RawMessage[]),
  )
  const messages = () => (live().length ? live() : (stored() ?? []))
  // The prompt shows as the bubble on top; the transcript starts after it.
  const rest = () => messages().filter((m, i) => !(i === 0 && m.type === "user"))
  const model = () => {
    const id = messages().find((m) => m.type === "assistant")?.message?.model as string | undefined
    return id ? modelName(id) : undefined
  }
  return (
    <PaneFrame
      label="Background tasks"
      head={
        <>
          <button class="cc-icon-btn cc-small" aria-label="Back" onClick={closeSubagent}>
            <Icon name="back" size={15} />
          </button>
          <span class="cc-pane-title cc-ellipsis">{props.task.description}</span>
        </>
      }
    >
      <div class="cc-pane-body cc-subagent">
        <Show when={props.task.prompt}>
          <div class="cc-user">
            <div class="cc-bubble">{props.task.prompt}</div>
          </div>
        </Show>
        <Show when={model()}>
          <p class="cc-subagent-model">
            <span class="cc-muted">Model</span> {model()}
          </p>
        </Show>
        <Show when={!stored.loading || live().length} fallback={<div class="cc-muted">Loading…</div>}>
          <SubagentMessages messages={rest()} />
        </Show>
        <Show when={props.task.status === "running"}>
          <div class="cc-working">
            <span class="cc-dots" />
            <span class="cc-sr">The subagent is working</span>
          </div>
        </Show>
      </div>
    </PaneFrame>
  )
}

// ── Preview ─────────────────────────────────────────────────────────────────────────────────

const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i
const VIDEO = /\.(mp4|webm)$/i
const AUDIO = /\.(mp3|wav|ogg)$/i
const PAGE = /\.(html?|svg)$/i
const previewUrl = (path: string) => `${state.previewBase}${path.split("/").map(encodeURIComponent).join("/")}`

export function PreviewPane() {
  const current = () => state.preview.history[state.preview.at] as string | undefined
  const [files] = createResource(
    () => state.changesVersion + 1,
    () => call<{ files: string[] }>("files/tree", {}).then((r) => r.files.filter(previewable)).catch(() => [] as string[]),
  )
  return (
    <PaneFrame
      label="Preview"
      head={
        <>
          <Popover
            trigger={(open, toggle) => (
              <button class="cc-preview-address" aria-label="Servers & settings" aria-haspopup="menu" aria-expanded={open()} onClick={toggle}>
                <Icon name="globe" size={15} />
                <span class="cc-ellipsis">{current() ?? ""}</span>
                <Icon name="chevronDown" size={12} />
              </button>
            )}
          >
            {(close) => (
              <MenuList
                close={close}
                items={[
                  { heading: "Workspace files" },
                  ...((files() ?? []).length
                    ? (files() ?? []).slice(0, 40).map((path) => ({ label: path, checked: path === current(), onSelect: () => openPreview(path) }))
                    : [{ label: "No pages, images or PDFs yet", disabled: true }]),
                  { separator: true },
                  { label: "Detect dev server", locked: LOCKED },
                ]}
              />
            )}
          </Popover>
          <div class="cc-grow" />
          <button class="cc-icon-btn cc-small" aria-label="Go back" disabled={state.preview.at <= 0} onClick={() => stepPreview(-1)}>
            <Icon name="back" size={15} />
          </button>
          <button class="cc-icon-btn cc-small" aria-label="Go forward" disabled={state.preview.at >= state.preview.history.length - 1} onClick={() => stepPreview(1)}>
            <Icon name="forward" size={15} />
          </button>
          <button class="cc-icon-btn cc-small" aria-label="Select an element or annotate" aria-keyshortcuts="Control+Shift+S" aria-pressed="false" title={LOCKED} disabled>
            <Icon name="pointer" size={15} />
          </button>
          <button class="cc-icon-btn cc-small" aria-label="Reload" aria-keyshortcuts="F5" disabled={!current()} onClick={reloadPreview}>
            <Icon name="rewind" size={15} />
          </button>
          <Popover
            align="end"
            trigger={(_, toggle) => (
              <button class="cc-icon-btn cc-small" aria-label="Preview settings" aria-haspopup="menu" onClick={toggle}>
                <Icon name="moreVertical" size={15} />
              </button>
            )}
          >
            {(close) => (
              <MenuList
                close={close}
                items={[
                  { label: "Auto-open files Claude writes", checked: prefs.autoOpen, checkable: true, onSelect: () => setPref("autoOpen", !prefs.autoOpen) },
                  { label: "Show in Files", disabled: !current(), onSelect: () => openFileInPane(current()!) },
                ]}
              />
            )}
          </Popover>
        </>
      }
    >
      <Show
        when={state.previewBase && current()}
        fallback={
          <div class="cc-pane-empty cc-preview-empty">
            <Icon name="globe" size={28} />
            <strong>Preview files</strong>
            <span>Open a page, image, or PDF from the workspace, or ask Claude to make one. Browsing websites isn’t available in this task.</span>
            <span class="cc-preview-dev">
              Preview your app instead?{" "}
              <button class="cc-link-btn" disabled title={LOCKED}>
                Detect dev server
              </button>
            </span>
          </div>
        }
      >
        {(path) => (
          <div class="cc-preview-body">
            {/* Keyed on the path and Reload, so either loads the file again. */}
            <For each={[`${path()}#${state.preview.reload}`]}>
              {() => (
                <Show
                  when={IMAGE.test(path()) || VIDEO.test(path()) || AUDIO.test(path())}
                  fallback={
                    <iframe
                      class="cc-preview-frame"
                      title={`Preview of ${path()}`}
                      src={previewUrl(path())}
                      // Pages run in an opaque origin: no access to this app, its storage or its APIs.
                      sandbox={PAGE.test(path()) ? "allow-scripts allow-forms allow-modals" : undefined}
                      referrerPolicy="no-referrer"
                    />
                  }
                >
                  <div class="cc-preview-media">
                    <Show when={IMAGE.test(path())}>
                      <img src={previewUrl(path())} alt={path()} />
                    </Show>
                    <Show when={VIDEO.test(path())}>
                      <video src={previewUrl(path())} controls />
                    </Show>
                    <Show when={AUDIO.test(path())}>
                      <audio src={previewUrl(path())} controls />
                    </Show>
                  </div>
                </Show>
              )}
            </For>
          </div>
        )}
      </Show>
    </PaneFrame>
  )
}

// ── Changes ─────────────────────────────────────────────────────────────────────────────────

type Diff = { available: boolean; base?: string | null; diff: string }

async function workspaceDiff(scope: "base" | "uncommitted"): Promise<Diff> {
  const res = await fetch(`${COSMO}/api/workspace/diff?scope=${scope}`)
  return res.ok ? res.json() : { available: false, diff: "" }
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")
const nameOf = (p: string) => p.split("/").pop() ?? p

export function ChangesPane() {
  const [scope, setScope] = createSignal<"base" | "uncommitted">("base")
  const [showFiles, setShowFiles] = createSignal(false)
  const [wrap, setWrap] = createSignal(true)
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const [refresh, setRefresh] = createSignal(0)
  const [diff] = createResource(() => ({ scope: scope(), version: state.changesVersion, refresh: refresh() }), (k) => workspaceDiff(k.scope))
  const files = createMemo(() => parseDiff(diff()?.diff ?? ""))
  const sum = () => totals(files())
  const base = () => diff()?.base ?? "main"
  const scopeLabel = () => (scope() === "base" ? `${base()} → working tree` : "Uncommitted changes")
  let body!: HTMLDivElement
  const goTo = (path: string) => body.querySelector(`[data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start" })
  return (
    <PaneFrame
      label="Changes"
      head={
        <>
          <button class="cc-icon-btn cc-small" aria-label="Show files" aria-pressed={showFiles()} aria-keyshortcuts="Control+Shift+Y" onClick={() => setShowFiles((v) => !v)}>
            <Icon name="list" size={15} />
          </button>
          <Popover
            trigger={(_, toggle) => (
              <button class="cc-scope-btn" aria-label={`Diff scope: ${scopeLabel()}`} aria-haspopup="menu" onClick={toggle}>
                <Show when={scope() === "base"} fallback={<span>Uncommitted changes</span>}>
                  <span>{base()}</span>
                  <Icon name="forward" size={13} aria-label="to" />
                  <span>working tree</span>
                </Show>
                <Icon name="chevronDown" size={13} />
              </button>
            )}
          >
            {(close) => (
              <MenuList
                close={close}
                items={[
                  { label: `All changes vs ${base()}`, checked: scope() === "base", onSelect: () => setScope("base") },
                  { label: "Uncommitted changes", checked: scope() === "uncommitted", onSelect: () => setScope("uncommitted") },
                  { separator: true },
                  { label: `Compare against ${base()}`, locked: LOCKED },
                ]}
              />
            )}
          </Popover>
          <span class="cc-stat">
            <span class="cc-add">+{sum().add}</span> <span class="cc-del">−{sum().del}</span>
          </span>
          <Popover
            align="end"
            trigger={(_, toggle) => (
              <button class="cc-icon-btn cc-small" aria-label="Changes settings" aria-haspopup="menu" onClick={toggle}>
                <Icon name="moreVertical" size={15} />
              </button>
            )}
          >
            {(close) => (
              <MenuList
                close={close}
                items={[
                  { label: "Show files", shortcut: "Ctrl+Shift+Y", checked: showFiles(), onSelect: () => setShowFiles((v) => !v) },
                  { separator: true },
                  { label: "Collapse all files", onSelect: () => setCollapsed(Object.fromEntries(files().map((f) => [f.path, true]))) },
                  { label: "Expand all files", onSelect: () => setCollapsed({}) },
                  { separator: true },
                  { label: "Word wrap", checked: wrap(), onSelect: () => setWrap((v) => !v) },
                  { separator: true },
                  { label: "Refresh", onSelect: () => setRefresh((n) => n + 1) },
                ]}
              />
            )}
          </Popover>
        </>
      }
    >
      <div class="cc-changes">
        <Show when={showFiles() && files().length}>
          <nav class="cc-change-list" aria-label="Changed files">
            <For each={files()}>
              {(f) => (
                <button class="cc-change-file" onClick={() => goTo(f.path)}>
                  <span class="cc-ellipsis">{nameOf(f.path)}</span>
                  <span class="cc-stat">
                    <span class="cc-add">+{f.add}</span> <span class="cc-del">−{f.del}</span>
                  </span>
                </button>
              )}
            </For>
          </nav>
        </Show>
        <div class="cc-pane-body cc-changes-body" ref={body}>
          <Show
            when={diff()?.available !== false}
            fallback={
              <div class="cc-pane-empty">
                <strong>Changes need a Git repository</strong>
                <span>None was found for this session, or its folder couldn't be reached.</span>
              </div>
            }
          >
            <For each={files()} fallback={<div class="cc-pane-empty">{diff.loading ? "Loading…" : "No changes"}</div>}>
              {(file) => (
                <FileDiff
                  file={file}
                  wrap={wrap()}
                  collapsed={!!collapsed()[file.path]}
                  toggle={() => setCollapsed((c) => ({ ...c, [file.path]: !c[file.path] }))}
                />
              )}
            </For>
          </Show>
        </div>
      </div>
    </PaneFrame>
  )
}

function FileDiff(props: { file: DiffFile; wrap: boolean; collapsed: boolean; toggle: () => void }) {
  return (
    <section class="cc-file-diff" data-file={props.file.path}>
      <header class="cc-file-diff-head">
        <button class="cc-file-diff-title" aria-expanded={!props.collapsed} onClick={props.toggle}>
          <Icon name={props.collapsed ? "chevronRight" : "chevronDown"} size={13} />
          <span>{nameOf(props.file.path)}</span>
          <span class="cc-muted">{dirOf(props.file.path)}</span>
          <span class="cc-stat">
            <span class="cc-add">+{props.file.add}</span> <span class="cc-del">−{props.file.del}</span>
          </span>
        </button>
        <div class="cc-grow" />
        <Show when={props.file.kind !== "delete"}>
          <button class="cc-link-btn cc-small-text" onClick={() => openFileInPane(props.file.path)}>
            Open file
          </button>
        </Show>
      </header>
      <Show when={!props.collapsed}>
        <table class="cc-diff cc-diff-pane" data-wrap={props.wrap ? "" : undefined}>
          <tbody>
            <For each={props.file.lines}>
              {(line) => (
                <tr data-kind={line.kind}>
                  <Show when={line.kind !== "hunk"} fallback={<td class="cc-diff-fold" colspan={3}>{line.text.replace(/^@@[^@]*@@\s?/, "") || "···"}</td>}>
                    <td class="cc-diff-no">{line.kind === "del" ? line.oldNo : line.newNo}</td>
                    <td class="cc-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
                    <td class="cc-diff-code">{line.text}</td>
                  </Show>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </section>
  )
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────

type Node = { name: string; path: string; dir: boolean; children: Node[] }

/** Paths → a folder tree, folders first, then by name. */
function tree(paths: string[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] }
  for (const p of paths) {
    let at = root
    const parts = p.split("/")
    parts.forEach((name, i) => {
      const last = i === parts.length - 1
      let next = at.children.find((c) => c.name === name && c.dir === !last)
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join("/"), dir: !last, children: [] }
        at.children.push(next)
      }
      at = next
    })
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    n.children.forEach(sort)
  }
  sort(root)
  return root.children
}

const CODE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|php|c|cc|cpp|h|cs|swift|kt|sh|css|html|json|toml|ya?ml)$/i

function TreeRows(props: { nodes: Node[]; depth: number; open: Record<string, boolean>; toggle: (p: string) => void }) {
  return (
    <For each={props.nodes}>
      {(n) => (
        <>
          <button
            class="cc-tree-row"
            role="treeitem"
            aria-level={props.depth + 1}
            aria-expanded={n.dir ? !!props.open[n.path] : undefined}
            data-active={state.openFile === n.path ? "" : undefined}
            style={{ "padding-left": `${8 + props.depth * 14}px` }}
            onClick={() => (n.dir ? props.toggle(n.path) : openFileInPane(n.path))}
          >
            <Icon name={n.dir ? (props.open[n.path] ? "chevronDown" : "chevronRight") : CODE.test(n.name) ? "code" : "file"} size={13} />
            <span class="cc-ellipsis">{n.name}</span>
          </button>
          <Show when={n.dir && props.open[n.path]}>
            <TreeRows nodes={n.children} depth={props.depth + 1} open={props.open} toggle={props.toggle} />
          </Show>
        </>
      )}
    </For>
  )
}

const LANGUAGES: Record<string, string> = { py: "python", js: "javascript", mjs: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx", json: "json", md: "markdown", sh: "bash", yml: "yaml", yaml: "yaml", toml: "toml", html: "html", css: "css", go: "go", rs: "rust", java: "java", rb: "ruby" }

function FileView(props: { path: string }) {
  const [file] = createResource(
    () => ({ path: props.path, version: state.changesVersion }),
    (k) => call<{ content?: string; binary?: boolean; tooLarge?: boolean; size: number }>("files/read", { path: k.path }).catch((e: Error) => ({ error: e.message }) as const),
  )
  const fenced = (text: string) => {
    const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)))
    return `${fence}${LANGUAGES[props.path.split(".").pop() ?? ""] ?? "text"}\n${text.replace(/\n$/, "")}\n${fence}`
  }
  return (
    <div class="cc-file-view">
      <Show when={file()} fallback={<div class="cc-pane-empty">Loading…</div>}>
        {(f) => {
          const loaded = f() as { content?: string; binary?: boolean; tooLarge?: boolean; error?: string }
          if (loaded.error) return <div class="cc-pane-empty">{loaded.error}</div>
          if (loaded.binary) return <div class="cc-pane-empty">This file is binary and can't be shown.</div>
          if (loaded.tooLarge) return <div class="cc-pane-empty">This file is too large to show.</div>
          const text = loaded.content ?? ""
          return (
            <div class="cc-file-grid">
              <pre class="cc-file-gutter" aria-hidden="true">
                {Array.from({ length: text.replace(/\n$/, "").split("\n").length }, (_, i) => i + 1).join("\n")}
              </pre>
              <Markdown class="cc-file-code" text={fenced(text)} />
            </div>
          )
        }}
      </Show>
    </div>
  )
}

export function FilesPane() {
  const [showTree, setShowTree] = createSignal(true)
  const [filter, setFilter] = createSignal("")
  const [open, setOpen] = createSignal<Record<string, boolean>>({})
  const [list] = createResource(() => state.changesVersion + 1, () => call<{ files: string[] }>("files/tree", {}).then((r) => r.files).catch(() => []))
  const nodes = createMemo(() => {
    const q = filter().trim().toLowerCase()
    return tree((list() ?? []).filter((p) => !q || p.toLowerCase().includes(q)))
  })
  // While filtering, every folder on the way to a match is open.
  const isOpen = createMemo(() => (filter().trim() ? new Proxy({}, { get: () => true }) : open()))
  return (
    <PaneFrame
      label="Files"
      head={
        <>
          <button class="cc-icon-btn cc-small" aria-label="Hide file tree" aria-pressed={showTree()} aria-keyshortcuts="Control+Shift+Y" onClick={() => setShowTree((v) => !v)}>
            <Icon name="list" size={15} />
          </button>
          <span class="cc-pane-title">Files</span>
        </>
      }
    >
      <div class="cc-files">
        <Show when={showTree()}>
          <div class="cc-tree">
            <label class="cc-filter">
              <Icon name="search" size={13} />
              <input
                aria-label="Filter files"
                aria-description="Results update as you type."
                placeholder="Filter files"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
            </label>
            <div role="tree" aria-label="Files">
              <TreeRows nodes={nodes()} depth={0} open={isOpen() as Record<string, boolean>} toggle={(p) => setOpen((o) => ({ ...o, [p]: !o[p] }))} />
            </div>
          </div>
        </Show>
        <div class="cc-open-files">
          <Show
            when={state.openFile}
            fallback={
              <div class="cc-pane-empty">
                <Icon name="folder" size={22} />
                <strong>Open files appear here</strong>
                <span>Pick a file in the tree, or click a file path in the conversation.</span>
              </div>
            }
          >
            <div class="cc-file-tabs" role="tablist">
              <For each={state.openFiles}>
                {(path) => (
                  <div class="cc-file-tab" role="tab" aria-selected={state.openFile === path} title={path}>
                    <button class="cc-ellipsis" onClick={() => openFileInPane(path)}>
                      {nameOf(path)}
                    </button>
                    <button class="cc-icon-btn cc-small" aria-label={`Close ${nameOf(path)}`} onClick={() => closeFile(path)}>
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                )}
              </For>
            </div>
            <Show when={previewable(state.openFile!)}>
              <div class="cc-file-actions">
                <button class="cc-btn" onClick={() => openPreview(state.openFile!)}>
                  <Icon name="play" size={13} /> Open in Preview
                </button>
              </div>
            </Show>
            <FileView path={state.openFile!} />
          </Show>
        </div>
      </div>
    </PaneFrame>
  )
}

// ── Terminal ────────────────────────────────────────────────────────────────────────────────

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: import("ghostty-web").Ghostty }> | undefined
const loadGhostty = () =>
  (shared ??= import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((error) => {
      shared = undefined
      throw error
    }))

const encoder = new TextEncoder()
function toBase64(text: string) {
  const bytes = encoder.encode(text)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function terminalColors() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return { background: v("--v2-background-bg-base", "#ffffff"), foreground: v("--v2-text-text-base", "#1f2328"), cursor: v("--v2-text-text-base", "#1f2328") }
}

/** One shell: opened by the engine host in the workspace sandbox, ended when its tab closes. */
function TerminalView(props: { active: boolean }) {
  const theme = useTheme()
  let container!: HTMLDivElement
  let term: Terminal | undefined
  let fit: FitAddon | undefined
  let id: string | undefined
  let exited = false
  const cleanups: (() => void)[] = []
  const send = (method: string, params: object) => (id ? call(method, { id, ...params }).catch(() => {}) : undefined)
  // Keystrokes go out one call at a time (calls in flight together can arrive out of order); what's
  // typed meanwhile goes in the next call.
  let typed = ""
  let writing = false
  const write = async (data: string) => {
    typed += data
    if (writing) return
    writing = true
    while (typed && !exited) {
      const chunk = typed
      typed = ""
      await send("terminal/write", { data: toBase64(chunk) })
    }
    writing = false
  }
  onMount(async () => {
    const { mod, ghostty } = await loadGhostty()
    const t = new mod.Terminal({ cursorBlink: true, cursorStyle: "bar", fontSize: 13, fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--cc-mono").trim() || "JetBrains Mono, ui-monospace, monospace", theme: terminalColors(), scrollback: 10_000, ghostty })
    term = t
    cleanups.push(() => t.dispose())
    fit = new mod.FitAddon()
    t.loadAddon(fit)
    t.open(container)
    fit.fit()
    fit.observeResize()
    try {
      id = (await call<{ id: string }>("terminal/open", { cols: t.cols, rows: t.rows })).id
    } catch (error) {
      t.write(`\x1b[31m${error instanceof Error ? error.message : "The terminal couldn't start."}\x1b[0m\r\n`)
      exited = true
      return
    }
    const decoder = new TextDecoder()
    cleanups.push(
      onTerminal(id, (event) => {
        if (event.data) t.write(decoder.decode(event.data, { stream: true }))
        if (event.exit !== undefined) {
          exited = true
          t.write(`\r\n\x1b[2m[Process exited with code ${event.exit ?? "?"}]\x1b[0m\r\n`)
        }
      }),
    )
    const onData = t.onData((data) => !exited && void write(data))
    const onResize = t.onResize((size) => !exited && void send("terminal/resize", { cols: size.cols, rows: size.rows }))
    cleanups.push(() => onData.dispose(), () => onResize.dispose())
    if (props.active) t.focus()
  })
  createEffect(() => {
    theme.mode()
    if (term?.options) term.options.theme = terminalColors()
  })
  createEffect(() => {
    if (props.active && term) queueMicrotask(() => (fit?.fit(), term?.focus()))
  })
  onCleanup(() => {
    if (!exited) void send("terminal/close", {})
    for (const fn of cleanups) fn()
  })
  return <div class="cc-terminal" ref={container} onClick={() => term?.focus()} />
}

let terminalSeq = 0

/** Kept mounted once opened (shells keep running while the pane is hidden). */
export function TerminalPane(props: { hidden: boolean }) {
  const [tabs, setTabs] = createSignal<number[]>([++terminalSeq])
  const [active, setActive] = createSignal(tabs()[0]!)
  const add = () => {
    const n = ++terminalSeq
    setTabs((t) => [...t, n])
    setActive(n)
  }
  const close = (n: number) => {
    const rest = tabs().filter((t) => t !== n)
    setTabs(rest)
    if (active() === n && rest.length) setActive(rest.at(-1)!)
    if (!rest.length) closePane()
  }
  createEffect(on(() => props.hidden, (hidden) => !hidden && !tabs().length && add()))
  return (
    <PaneFrame
      label="Terminal"
      hidden={props.hidden}
      head={
        <>
          <div class="cc-term-tabs" role="tablist" aria-label="Terminal tabs">
            <For each={tabs()}>
              {(n) => (
                <div class="cc-term-tab" role="tab" aria-selected={active() === n} aria-label={`Terminal , ${FOLDER}`}>
                  <button onClick={() => setActive(n)}>
                    Terminal <span class="cc-muted">{FOLDER}</span>
                  </button>
                  <Show when={tabs().length > 1}>
                    <button class="cc-icon-btn cc-small" aria-label="Close terminal" onClick={() => close(n)}>
                      <Icon name="close" size={11} />
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <button class="cc-icon-btn cc-small" aria-label="New terminal" onClick={add}>
            <Icon name="plus" size={15} />
          </button>
        </>
      }
    >
      <Show
        when={state.terminal}
        fallback={
          <div class="cc-pane-empty">
            <Icon name="lock" size={18} />
            <strong>The terminal isn't available in this task</strong>
          </div>
        }
      >
        <For each={tabs()}>
          {(n) => (
            <div class="cc-term-panel" hidden={active() !== n}>
              <TerminalView active={active() === n && !props.hidden} />
            </div>
          )}
        </For>
      </Show>
    </PaneFrame>
  )
}
