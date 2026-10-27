// A file tab: the workspace file, read through the engine (fs/readFile, clamped to the workspace by
// the gateway), shown read-only with syntax highlighting and line numbers. Re-read after each turn,
// since the agent may have changed it.
import { createResource, Match, Show, Switch } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { Icon } from "../icons"
import { call } from "../engine"
import { copy, state, WORKSPACE } from "../store"
import type { FsReadFileResponse } from "../protocol/v2/FsReadFileResponse"

const MAX_BYTES = 512 * 1024

const LANGUAGES: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx",
  json: "json", md: "markdown", sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "toml",
  html: "html", css: "css", scss: "scss", go: "go", rs: "rust", java: "java", kt: "kotlin", rb: "ruby",
  php: "php", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", swift: "swift", sql: "sql",
  xml: "xml", dockerfile: "dockerfile", makefile: "makefile", txt: "text",
}

function language(path: string) {
  const name = path.split("/").pop()!.toLowerCase()
  return LANGUAGES[name] ?? LANGUAGES[name.split(".").pop() ?? ""] ?? "text"
}

type Loaded = { kind: "text"; text: string } | { kind: "binary" } | { kind: "large"; size: number } | { kind: "missing"; message: string }

async function read(key: { path: string; refresh: number }): Promise<Loaded> {
  try {
    const res = await call<FsReadFileResponse>("fs/readFile", { path: `${WORKSPACE}/${key.path}` })
    const bytes = Uint8Array.from(atob(res.dataBase64), (c) => c.charCodeAt(0))
    if (bytes.length > MAX_BYTES) return { kind: "large", size: bytes.length }
    if (bytes.subarray(0, 8000).includes(0)) return { kind: "binary" }
    return { kind: "text", text: new TextDecoder().decode(bytes) }
  } catch (error) {
    return { kind: "missing", message: error instanceof Error ? error.message : "The file couldn't be read." }
  }
}

export function FileView(props: { path: string }) {
  const [file] = createResource(() => ({ path: props.path, refresh: state.tabs.refresh }), read)
  // A fence longer than any backtick run in the file keeps it one code block.
  const fenced = (text: string) => {
    const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)))
    return `${fence}${language(props.path)}\n${text.replace(/\n$/, "")}\n${fence}`
  }
  return (
    <div class="cx-tab-body">
      <div class="cx-changes-toolbar">
        <Icon name="file" size={14} />
        <span class="cx-file-path">{props.path}</span>
        <div class="cx-grow" />
        <span class="cx-menu-subtitle">Read-only</span>
        <button class="cx-icon-btn cx-small" aria-label="Copy path" title="Copy path" onClick={() => void copy(props.path, "Path")}>
          <Icon name="copy" size={14} />
        </button>
      </div>
      <div class="cx-file-body">
        <Show when={file()} fallback={<div class="cx-loading">Loading…</div>}>
          {(loaded) => (
            <Switch>
              <Match when={loaded().kind === "text" && (loaded() as { text: string }).text}>
                {(text) => (
                  <div class="cx-file-grid">
                    <pre class="cx-file-gutter" aria-hidden="true">
                      {Array.from({ length: text().replace(/\n$/, "").split("\n").length }, (_, i) => i + 1).join("\n")}
                    </pre>
                    <Markdown class="cx-file-code" text={fenced(text())} cacheKey={`file:${props.path}:${state.tabs.refresh}`} />
                  </div>
                )}
              </Match>
              <Match when={loaded().kind === "text"}>
                <div class="cx-empty-row">Empty file</div>
              </Match>
              <Match when={loaded().kind === "binary"}>
                <div class="cx-empty-row">This file is binary and can't be shown.</div>
              </Match>
              <Match when={loaded().kind === "large" && loaded()}>
                {(l) => <div class="cx-empty-row">This file is too large to show ({Math.round((l() as { size: number }).size / 1024)} KB).</div>}
              </Match>
              <Match when={loaded().kind === "missing" && loaded()}>
                {(l) => <div class="cx-empty-row">{(l() as { message: string }).message}</div>}
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </div>
  )
}
