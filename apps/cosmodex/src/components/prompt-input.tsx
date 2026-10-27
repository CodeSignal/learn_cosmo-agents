// The composer's input. Plain text plus inline chips, as in the original: file chips (from "@" or
// the command menu) are sent as text elements over their path; skill chips (from "/") go as skill
// inputs. Typing "/" in an empty input opens the commands popover, "@" opens files; arrows move,
// Enter or Tab picks, Esc closes.
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { Icon, type IconName } from "../icons"
import { registerEditor } from "../editor"
import { call } from "../engine"
import { prefs } from "../prefs"
import {
  activeThread,
  effortLabel,
  loadSkills,
  modelName,
  PROJECT,
  rememberFile,
  send,
  setPlanMode,
  state,
  threadOrder,
  threadTitle,
  WORKSPACE,
  type Draft,
} from "../store"
import type { FuzzyFileSearchResponse } from "../protocol/FuzzyFileSearchResponse"
import type { FsReadDirectoryResponse } from "../protocol/v2/FsReadDirectoryResponse"
import type { ListMcpServerStatusResponse } from "../protocol/v2/ListMcpServerStatusResponse"
import type { TextElement } from "../protocol/v2/TextElement"

const LOCKED = "Not available in this task"

const INIT_PROMPT = [
  "Generate a file named AGENTS.md that serves as a contributor guide for this repository.",
  "Look at the project's structure, build and test commands, coding style and conventions, and",
  "write concise, well-organised instructions (around 200-400 words) for agents working in it.",
].join(" ")

type Trigger = { kind: "slash" | "mention"; query: string; node: Text; start: number; end: number }
type Row = { key: string; icon: IconName; label: string; description?: string; badge?: string; locked?: string; more?: boolean; pick?: () => void }
type Group = { title?: string; rows: Row[]; empty?: string }
type View = "list" | "mcp" | "status" | "files"

const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).length

/** Read the input back as a draft: text, the file chips' byte ranges, and the chosen skills. */
function serialize(root: HTMLElement): Draft {
  let text = ""
  const elements: TextElement[] = []
  const skills: Draft["skills"] = []
  const walk = (node: Node) => {
    if (node instanceof Text) {
      text += node.data.replace(/ /g, " ")
    } else if (node instanceof HTMLElement) {
      if (node.dataset.mention) {
        const start = bytes(text)
        text += node.dataset.mention
        elements.push({ byteRange: { start, end: bytes(text) }, placeholder: node.dataset.mention.split("/").pop() ?? null })
      } else if (node.dataset.skill) {
        skills.push({ name: node.dataset.skill, path: node.dataset.path! })
      } else if (node.tagName === "BR") {
        text += "\n"
      } else {
        const block = node.tagName === "DIV" || node.tagName === "P"
        if (block && text && !text.endsWith("\n")) text += "\n"
        node.childNodes.forEach(walk)
      }
    }
  }
  root.childNodes.forEach(walk)
  // Trim, moving the chips' ranges with the text.
  const lead = text.length - text.trimStart().length
  const shift = bytes(text.slice(0, lead))
  text = text.trim()
  const end = bytes(text)
  return {
    text,
    elements: elements.map((e) => ({ ...e, byteRange: { start: e.byteRange.start - shift, end: e.byteRange.end - shift } })).filter((e) => e.byteRange.start >= 0 && e.byteRange.end <= end),
    skills,
  }
}

function chip(kind: "mention" | "skill", label: string, data: Record<string, string>) {
  const el = document.createElement("span")
  el.className = `cx-mention${kind === "skill" ? " cx-skill" : ""}`
  el.contentEditable = "false"
  Object.assign(el.dataset, data)
  el.textContent = label
  return el
}

function placeCaretAfter(node: Node) {
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  const sel = getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

const scopeLabel = (scope: string) => ({ system: "System", user: "Personal", repo: "Repo", admin: "Admin" })[scope] ?? scope

export function PromptInput(props: { placeholder: string; onEmptyChange: (empty: boolean) => void; submitRef?: (submit: () => void) => void }) {
  let el!: HTMLDivElement
  const [empty, setEmpty] = createSignal(true)
  const [trigger, setTrigger] = createSignal<Trigger | null>(null)
  const [view, setView] = createSignal<View>("list")
  const [active, setActive] = createSignal(0)

  const refresh = () => {
    const draft = serialize(el)
    const isEmpty = !draft.text && !draft.skills.length
    setEmpty(isEmpty)
    props.onEmptyChange(isEmpty)
    if (isEmpty && el.innerHTML && !el.textContent) el.innerHTML = "" // leftover <br>, so the placeholder shows
    detect()
  }

  /** Is the caret right after "/command" (whole input) or "@query"? */
  const detect = () => {
    const sel = getSelection()
    const node = sel?.anchorNode
    if (!sel?.isCollapsed || !(node instanceof Text) || !el.contains(node)) return close()
    const before = node.data.slice(0, sel.anchorOffset)
    const mention = /(?:^|[\s ])@([^\s @]*)$/.exec(before)
    if (mention) {
      const query = mention[1]!
      return open({ kind: "mention", query, node, start: sel.anchorOffset - query.length - 1, end: sel.anchorOffset })
    }
    const slash = /^\/(\S*)$/.exec(before)
    if (slash && el.textContent === node.data && node.data === before) {
      return open({ kind: "slash", query: slash[1]!, node, start: 0, end: sel.anchorOffset })
    }
    close()
  }
  const open = (t: Trigger) => {
    const prev = trigger()
    if (!prev || prev.kind !== t.kind) setView("list")
    setTrigger(t)
  }
  const close = () => {
    setTrigger(null)
    setView("list")
  }

  /** Remove the "/cmd" or "@query" the popover was opened with. */
  const consume = () => {
    const t = trigger()
    if (!t || !t.node.isConnected) return null
    const range = document.createRange()
    range.setStart(t.node, Math.min(t.start, t.node.length))
    range.setEnd(t.node, Math.min(t.end, t.node.length))
    range.deleteContents()
    return range
  }

  const insertChip = (node: HTMLElement, range?: Range | null) => {
    el.focus()
    let at = range
    if (!at) {
      const sel = getSelection()
      at = sel?.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0) : null
    }
    if (!at) {
      at = document.createRange()
      at.selectNodeContents(el)
      at.collapse(false)
    }
    at.insertNode(node)
    const space = document.createTextNode(" ")
    node.after(space)
    placeCaretAfter(space)
    close()
    refresh()
  }

  const mention = (path: string, range?: Range | null) => {
    rememberFile(path)
    insertChip(chip("mention", path.split("/").pop() ?? path, { mention: path }), range)
  }

  const runCommand = (fn: () => void) => {
    consume()
    close()
    refresh()
    fn()
  }

  // Commands (S20): the original's list; what a task can't offer is locked.
  const commands = (): Row[] => [
    { key: "chat", icon: "chat", label: "Chat", description: "Don't work in a project", locked: LOCKED },
    { key: "feedback", icon: "feedback", label: "Feedback", description: "Send feedback about this chat", locked: LOCKED },
    { key: "goal", icon: "target", label: "Goal", description: "Set a goal to keep pursuing", locked: LOCKED },
    { key: "init", icon: "file", label: "Init", description: "Create an AGENTS.md file with instructions for Cosmodex", pick: () => runCommand(() => void send(INIT_PROMPT)) },
    { key: "mcp", icon: "plug", label: "MCP", description: "Show MCP server status", more: true, pick: () => setView("mcp") },
    { key: "pet", icon: "smile", label: "Pet", description: "Wake or tuck away the desktop pet", locked: LOCKED },
    {
      key: "plan",
      icon: "bulb",
      label: "Plan mode",
      description: state.planMode ? "Turn plan mode off" : "Turn plan mode on",
      pick: () => runCommand(() => setPlanMode(!state.planMode)),
    },
    { key: "sketch", icon: "pencil", label: "Sketch", description: "Draw a sketch", locked: LOCKED },
    { key: "status", icon: "gauge", label: "Status", description: "Show chat ID, context usage, and rate limits", pick: () => setView("status") },
    { key: "project", icon: "folder", label: "Work in a project", description: "Choose project for new chats", more: true, locked: LOCKED },
  ]

  const skillRows = (): Row[] =>
    state.skills.map((skill) => ({
      key: `skill-${skill.path}`,
      icon: "sparkle",
      label: skill.interface?.displayName ?? skill.name,
      description: skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
      badge: scopeLabel(skill.scope),
      pick: () => insertChip(chip("skill", skill.interface?.displayName ?? skill.name, { skill: skill.name, path: skill.path }), consume()),
    }))

  // "@" with no query (S21): Add · then files and chats as you type.
  const addRows = (): Row[] => [
    { key: "files", icon: "file", label: "Files and folders", pick: () => setView("files") },
    { key: "project", icon: "folder", label: "Work in a project", description: "Choose project for new chats", locked: LOCKED },
    { key: "goal", icon: "target", label: "Goal", description: "Set a goal to keep pursuing", locked: LOCKED },
    {
      key: "plan",
      icon: "bulb",
      label: "Plan mode",
      description: state.planMode ? "Turn plan mode off" : "Turn plan mode on",
      pick: () => runCommand(() => setPlanMode(!state.planMode)),
    },
    { key: "sketch", icon: "pencil", label: "Sketch", description: "Draw a sketch", locked: LOCKED },
  ]

  const mentionQuery = () => (trigger()?.kind === "mention" ? trigger()!.query : "")
  const [found] = createResource(
    () => (mentionQuery() ? mentionQuery() : null),
    async (query) => {
      try {
        const res = await call<FuzzyFileSearchResponse>("fuzzyFileSearch", { query, roots: [WORKSPACE], cancellationToken: null })
        return res.files.slice(0, 12)
      } catch {
        return []
      }
    },
  )
  const [listing] = createResource(
    () => (view() === "files" ? WORKSPACE : null),
    async (path) => {
      try {
        const res = await call<FsReadDirectoryResponse>("fs/readDirectory", { path })
        return res.entries.filter((e) => !e.fileName.startsWith(".")).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.fileName.localeCompare(b.fileName))
      } catch {
        return []
      }
    },
  )
  const [servers] = createResource(
    () => (view() === "mcp" ? true : null),
    () => call<ListMcpServerStatusResponse>("mcpServerStatus/list", {}).then((r) => r.data).catch(() => []),
  )

  const groups = createMemo((): Group[] => {
    const t = trigger()
    if (!t) return []
    const q = t.query.toLowerCase()
    const match = (r: Row) => !q || r.label.toLowerCase().includes(q)
    if (view() === "status" || view() === "mcp") return []
    if (view() === "files") {
      return [
        {
          title: PROJECT,
          rows: (listing() ?? []).filter((e) => !q || e.fileName.toLowerCase().includes(q)).map((e) => ({ key: `ls-${e.fileName}`, icon: e.isDirectory ? "folder" : "file", label: e.fileName, pick: () => mention(e.fileName, consume()) })),
          empty: listing.loading ? "Loading…" : "No files",
        },
      ]
    }
    if (t.kind === "slash") {
      return [
        { rows: commands().filter(match) },
        { title: "Skills", rows: skillRows().filter(match) },
      ]
    }
    if (!q) return [{ title: "Add", rows: addRows() }, { title: "Files and chats", rows: [], empty: "Type to search files or chats" }]
    const chats = threadOrder()
      .filter((th) => threadTitle(th).toLowerCase().includes(q))
      .slice(0, 6)
      .map((th): Row => ({ key: `chat-${th.id}`, icon: "chat", label: threadTitle(th), locked: LOCKED }))
    const files = (found() ?? []).map((f): Row => ({ key: `f-${f.path}`, icon: "file", label: f.path, pick: () => mention(f.path, consume()) }))
    return [{ rows: [...files, ...chats], empty: found.loading ? "Searching…" : "No matching files or chats" }]
  })
  const rows = createMemo(() => groups().flatMap((g) => g.rows))
  createEffect(on(() => [trigger()?.kind, trigger()?.query, view()], () => setActive(Math.max(0, rows().findIndex((r) => r.pick && !r.locked)))))
  const showPopover = () => !!trigger() && (view() !== "list" || groups().some((g) => g.rows.length || g.empty))

  const pick = (row: Row | undefined) => {
    if (!row || row.locked || !row.pick) return
    row.pick()
  }

  const submit = () => {
    const draft = serialize(el)
    if (!draft.text && !draft.skills.length) return
    el.innerHTML = ""
    close()
    refresh()
    void send(draft)
  }
  props.submitRef?.(submit)

  onMount(() => {
    if (!state.skills.length) void loadSkills()
    const unregister = registerEditor({
      focus: () => el.focus(),
      insertMention: (path) => mention(path),
      type: (text) => {
        el.focus()
        document.execCommand("insertText", false, text)
        refresh()
      },
      browseFiles: () => {
        el.focus()
        document.execCommand("insertText", false, empty() ? "@" : " @")
        refresh()
        setView("files")
      },
    })
    onCleanup(unregister)
  })
  createEffect(on(active, (i) => document.querySelector(`.cx-prompt-popover [data-index="${i}"]`)?.scrollIntoView({ block: "nearest" })))

  const onKeyDown = (e: KeyboardEvent) => {
    if (showPopover()) {
      const n = rows().length
      if (e.key === "ArrowDown" && n) return (e.preventDefault(), setActive((i) => (i + 1) % n))
      if (e.key === "ArrowUp" && n) return (e.preventDefault(), setActive((i) => (i - 1 + n) % n))
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && n) return (e.preventDefault(), pick(rows()[active()]))
      if (e.key === "Escape") return (e.preventDefault(), e.stopPropagation(), view() === "list" ? close() : setView("list"))
      // Status and MCP are read-only panels: Enter closes them and clears the command.
      if (e.key === "Enter" && (view() === "status" || view() === "mcp")) return (e.preventDefault(), runCommand(() => {}))
    }
    if (e.key !== "Enter" || e.isComposing) return
    if (e.shiftKey) {
      e.preventDefault()
      document.execCommand("insertLineBreak")
      return refresh()
    }
    const withCtrl = e.ctrlKey || e.metaKey
    if (prefs.sendShortcut === "Enter" ? !withCtrl : withCtrl) {
      e.preventDefault()
      submit()
    } else if (prefs.sendShortcut === "Ctrl+Enter" && !withCtrl) {
      e.preventDefault()
      document.execCommand("insertLineBreak")
      refresh()
    }
  }

  const thread = () => activeThread()
  const usage = () => (thread() ? state.tokenUsage[thread()!.id] : undefined)

  return (
    <div class="cx-prompt">
      <Show when={showPopover()}>
        <div class="cx-prompt-popover" role="listbox" aria-label={trigger()?.kind === "slash" ? "Commands" : "Add to message"} onMouseDown={(e) => e.preventDefault()}>
          <Show when={view() === "status"}>
            <div class="cx-status-card">
              <div class="cx-command-heading">Status</div>
              <dl>
                <dt>Chat ID</dt>
                <dd>{thread()?.id ?? "New chat"}</dd>
                <dt>Model</dt>
                <dd>{modelName(state.model)} {effortLabel(state.effort)}</dd>
                <dt>Workspace</dt>
                <dd>{WORKSPACE}</dd>
                <dt>Context</dt>
                <dd>
                  {usage()
                    ? `${usage()!.last.totalTokens.toLocaleString()} tokens used${usage()!.modelContextWindow ? ` of ${usage()!.modelContextWindow!.toLocaleString()} (${Math.round((usage()!.last.totalTokens / usage()!.modelContextWindow!) * 100)}%)` : ""}`
                    : "No usage yet"}
                </dd>
                <dt>Rate limits</dt>
                <dd>Not available in this task</dd>
              </dl>
            </div>
          </Show>
          <Show when={view() === "mcp"}>
            <div class="cx-command-heading">MCP servers</div>
            <For each={servers() ?? []} fallback={<div class="cx-empty-row">{servers.loading ? "Loading…" : "No MCP servers connected"}</div>}>
              {(s) => (
                <div class="cx-prompt-row">
                  <Icon name="plug" size={14} /> {s.name}
                </div>
              )}
            </For>
          </Show>
          <Show when={view() === "list" || view() === "files"}>
            <For each={groups()}>
              {(group) => (
                <Show when={group.rows.length || group.empty}>
                  <Show when={group.title && (group.rows.length || group.empty)}>
                    <div class="cx-command-heading">{group.title}</div>
                  </Show>
                  <For each={group.rows} fallback={<div class="cx-empty-row">{group.empty}</div>}>
                    {(row) => {
                      const i = rows().indexOf(row)
                      return (
                        <button
                          role="option"
                          class="cx-prompt-row"
                          data-index={i}
                          aria-selected={active() === i}
                          aria-disabled={!!row.locked || !row.pick}
                          data-locked={row.locked ? "" : undefined}
                          onMouseMove={() => setActive(i)}
                          onClick={() => pick(row)}
                        >
                          <Icon name={row.icon} size={15} />
                          <span class="cx-prompt-label">{row.label}</span>
                          <Show when={row.description}>
                            <span class="cx-prompt-desc">{row.description}</span>
                          </Show>
                          <div class="cx-grow" />
                          <Show when={row.badge}>
                            <span class="cx-badge">{row.badge}</span>
                          </Show>
                          <Show when={row.locked}>
                            <span class="cx-lock-note">
                              <Icon name="lock" size={12} /> {row.locked}
                            </span>
                          </Show>
                          <Show when={row.more && !row.locked}>
                            <Icon name="chevronRight" size={14} />
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                </Show>
              )}
            </For>
          </Show>
        </div>
      </Show>
      <div
        ref={el}
        class="cx-input"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={props.placeholder}
        data-placeholder={props.placeholder}
        data-empty={empty() ? "" : undefined}
        onInput={refresh}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") && !showPopover() && detect()}
        onClick={detect}
        onBlur={() => setTimeout(() => document.activeElement !== el && close(), 0)}
        onPaste={(e) => {
          e.preventDefault()
          document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "")
        }}
        onDrop={(e) => e.preventDefault()}
      />
    </div>
  )
}
