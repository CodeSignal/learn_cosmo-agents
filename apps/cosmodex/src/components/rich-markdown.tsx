// Markdown in chats, with the original's controls (S31): code blocks get a header with the
// language, "Enable word wrap" and "Copy code"; tables get "Copy table" and "Expand table" (a
// dialog with the table at full size). The kit's renderer redraws blocks while a reply streams,
// so the controls are (re)attached by watching the rendered output.
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { showToast } from "../store"

const NAMES: Record<string, string> = {
  py: "Python", python: "Python", js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
  tsx: "TSX", jsx: "JSX", sh: "Shell", bash: "Bash", shell: "Shell", zsh: "Shell", json: "JSON", yaml: "YAML", yml: "YAML",
  toml: "TOML", html: "HTML", css: "CSS", sql: "SQL", go: "Go", rust: "Rust", rs: "Rust", java: "Java", c: "C", cpp: "C++",
  csharp: "C#", cs: "C#", ruby: "Ruby", rb: "Ruby", php: "PHP", md: "Markdown", markdown: "Markdown", diff: "Diff", text: "Text",
}

// Icons as SVG markup: these controls live inside the renderer's DOM, outside Solid.
const svg = (d: string) =>
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`
const ICON = {
  code: svg("M9 8l-4 4 4 4M15 8l4 4-4 4"),
  wrap: svg("M4 7h13a3 3 0 0 1 0 6h-4M15 11l-2 2 2 2M4 17h5"),
  copy: svg("M9 9h11v11H9zM5 15H4V4h11v1"),
  check: svg("M5 12l5 5L20 7"),
  expand: svg("M14 4h6v6M10 20H4v-6M20 4l-6 6M4 20l6-6"),
}

function iconButton(label: string, icon: string, onClick: (button: HTMLButtonElement) => void) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "cx-icon-btn cx-small"
  button.setAttribute("aria-label", label)
  button.title = label
  button.innerHTML = icon
  button.addEventListener("click", (e) => {
    e.stopPropagation()
    onClick(button)
  })
  return button
}

async function copyWithFeedback(button: HTMLButtonElement, text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    const icon = button.innerHTML
    button.innerHTML = ICON.check
    setTimeout(() => (button.innerHTML = icon), 1500)
  } catch {
    showToast(`Couldn't copy the ${what}.`)
  }
}

function decorateCode(block: HTMLElement) {
  const code = block.querySelector("code")
  const lang = [...(code?.classList ?? [])].find((c) => c.startsWith("language-"))?.slice(9) ?? block.dataset.language ?? "text"
  const head = document.createElement("div")
  head.className = "cx-code-head"
  head.dataset.cxControls = ""
  const label = document.createElement("span")
  label.className = "cx-code-lang"
  label.innerHTML = `${ICON.code}<span></span>`
  label.lastElementChild!.textContent = NAMES[lang.toLowerCase()] ?? lang
  const grow = document.createElement("div")
  grow.className = "cx-grow"
  const wrap = iconButton("Enable word wrap", ICON.wrap, (button) => {
    const on = block.toggleAttribute("data-wrap")
    button.setAttribute("aria-label", on ? "Disable word wrap" : "Enable word wrap")
    button.title = button.getAttribute("aria-label")!
    button.setAttribute("aria-pressed", String(on))
  })
  const copy = iconButton("Copy code", ICON.copy, (button) => void copyWithFeedback(button, block.querySelector("pre")?.textContent ?? "", "code"))
  head.append(label, grow, wrap, copy)
  block.prepend(head)
}

/** A table as Markdown (what "Copy table" puts on the clipboard). */
function tableMarkdown(table: HTMLTableElement) {
  const rows = [...table.rows].map((row) => [...row.cells].map((cell) => (cell.textContent ?? "").replace(/\|/g, "\\|").trim()))
  if (!rows.length) return ""
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`
  return [line(rows[0]!), line(rows[0]!.map(() => "---")), ...rows.slice(1).map(line)].join("\n") + "\n"
}

const [expanded, setExpanded] = createSignal<HTMLTableElement | null>(null)

function decorateTable(table: HTMLTableElement) {
  const bar = document.createElement("div")
  bar.className = "cx-table-bar"
  bar.dataset.cxControls = ""
  bar.append(
    iconButton("Copy table", ICON.copy, (button) => void copyWithFeedback(button, tableMarkdown(table), "table")),
    iconButton("Expand table", ICON.expand, () => setExpanded(table.cloneNode(true) as HTMLTableElement)),
  )
  table.before(bar)
}

function decorate(root: HTMLElement) {
  for (const block of root.querySelectorAll<HTMLElement>('[data-component="markdown-code"]')) {
    if (!block.querySelector(":scope > .cx-code-head")) decorateCode(block)
  }
  for (const table of root.querySelectorAll("table")) {
    if (!table.previousElementSibling?.classList.contains("cx-table-bar")) decorateTable(table)
  }
}

export function RichMarkdown(props: { text: string; class?: string; streaming?: boolean }) {
  let root!: HTMLDivElement
  onMount(() => {
    decorate(root)
    // Our own additions trigger the observer too; decorate() leaves decorated blocks alone.
    const observer = new MutationObserver(() => decorate(root))
    observer.observe(root, { childList: true, subtree: true })
    onCleanup(() => observer.disconnect())
  })
  return (
    <div class="cx-rich" ref={root}>
      <Markdown class={props.class} text={props.text} streaming={props.streaming} />
    </div>
  )
}

/** "Expand table": the table on its own, at full width. */
export function TableDialog() {
  return (
    <Show when={expanded()}>
      {(table) => (
        <div class="cx-scrim" onMouseDown={(e) => e.target === e.currentTarget && setExpanded(null)}>
          <div class="cx-dialog cx-table-dialog" role="dialog" aria-label="Table" onKeyDown={(e) => e.key === "Escape" && setExpanded(null)}>
            <div class="cx-table-dialog-head">
              <h2 class="cx-dialog-title">Table</h2>
              <div class="cx-grow" />
              <button class="cx-btn" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => setExpanded(null)}>
                Close
              </button>
            </div>
            <div class="cx-table-dialog-body cx-assistant" ref={(el) => el.replaceChildren(table())} />
          </div>
        </div>
      )}
    </Show>
  )
}
