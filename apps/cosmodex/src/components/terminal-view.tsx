// A terminal tab (only when the task enables the terminal): a login shell in the workspace, run by
// the engine as a PTY (command/exec) inside the task's sandbox — the workspace and /tmp are
// writable, there's no network. Keystrokes go back with command/exec/write; output arrives as
// command/exec/outputDelta. The tab takes the title the shell sets ("runner@host: /path").
import { createEffect, onCleanup, onMount } from "solid-js"
import type { FitAddon, Terminal } from "ghostty-web"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { call, EngineError } from "../engine"
import { onTerminalOutput, setTabTitle, WORKSPACE } from "../store"

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
// OSC 0/2: the shell setting the window title.
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g

const SANDBOXES = [
  { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  { type: "readOnly", networkAccess: false },
]

function colors() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    background: v("--v2-background-bg-base", "#ffffff"),
    foreground: v("--v2-text-text-base", "#1f2328"),
    cursor: v("--v2-text-text-base", "#1f2328"),
    selectionBackground: v("--v2-overlay-simple-overlay-hover", "#d0d7de"),
  }
}

export function TerminalView(props: { tabId: string; processId: string; active: boolean }) {
  const theme = useTheme()
  let container!: HTMLDivElement
  let term: Terminal | undefined
  let fit: FitAddon | undefined
  let exited = false
  const cleanups: (() => void)[] = []

  const send = (method: string, params: object) => call(method, { processId: props.processId, ...params }).catch(() => {})

  onMount(async () => {
    const { mod, ghostty } = await loadGhostty()
    const t = new mod.Terminal({ cursorBlink: true, cursorStyle: "bar", fontSize: 13, fontFamily: "JetBrains Mono, ui-monospace, monospace", theme: colors(), scrollback: 10_000, ghostty })
    term = t
    cleanups.push(() => t.dispose())
    fit = new mod.FitAddon()
    t.loadAddon(fit)
    t.open(container)
    fit.fit()
    fit.observeResize()

    const decoder = new TextDecoder()
    cleanups.push(
      onTerminalOutput(props.processId, (bytes) => {
        const text = decoder.decode(bytes, { stream: true })
        for (const m of text.matchAll(TITLE)) if (m[1]) setTabTitle(props.tabId, m[1])
        t.write(text)
      }),
    )
    const onData = t.onData((data) => {
      if (!exited) void send("command/exec/write", { deltaBase64: toBase64(data) })
    })
    const onResize = t.onResize((size) => {
      if (!exited) void send("command/exec/resize", { size: { cols: size.cols, rows: size.rows } })
    })
    cleanups.push(() => onData.dispose(), () => onResize.dispose())

    // Start the shell; the call returns when it exits. A task that only allows read-only gets that.
    const start = async (sandbox = 0): Promise<{ exitCode: number }> => {
      try {
        return await call<{ exitCode: number }>("command/exec", {
          // bash on a PTY of its own (job control, resizes): see root/bin/terminal-shell
          command: ["/opt/agentsim/bin/terminal-shell"],
          processId: props.processId,
          tty: true,
          streamStdin: true,
          streamStdoutStderr: true,
          disableTimeout: true,
          disableOutputCap: true,
          cwd: WORKSPACE,
          env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
          size: { cols: t.cols, rows: t.rows },
          sandboxPolicy: SANDBOXES[sandbox],
        })
      } catch (error) {
        if (error instanceof EngineError && error.blocked && sandbox + 1 < SANDBOXES.length) return start(sandbox + 1)
        throw error
      }
    }
    if (props.active) t.focus()
    start()
      .then((result) => t.write(`\r\n\x1b[2m[Process exited with code ${result.exitCode}]\x1b[0m\r\n`))
      .catch((error) => t.write(`\r\n\x1b[31m${error instanceof Error ? error.message : "The terminal couldn't start."}\x1b[0m\r\n`))
      .finally(() => (exited = true))
  })

  createEffect(() => {
    theme.mode()
    term?.options && (term.options.theme = colors())
  })
  createEffect(() => {
    if (props.active && term) {
      queueMicrotask(() => {
        fit?.fit()
        term?.focus()
      })
    }
  })

  onCleanup(() => {
    if (!exited) void send("command/exec/terminate", {})
    for (const fn of cleanups) fn()
  })

  return <div class="cx-terminal" ref={container} onClick={() => term?.focus()} />
}

/** When the page goes away, its terminals' shells end too. */
export function terminateOnUnload(processIds: () => string[]) {
  addEventListener("pagehide", () => {
    for (const processId of processIds()) {
      void fetch(`${import.meta.env.VITE_ENGINE_PATH ?? "/engine/cosmodex"}/rpc`, {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "command/exec/terminate", params: { processId } }),
      })
    }
  })
}
