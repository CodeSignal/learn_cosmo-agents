// The Cosmo Code window: title bar; sidebar · transcript with the composer · the session rail, or a
// pane (Plan, Changes, Terminal, Files) in its place. Without an open session the main column is a
// new session (the prompt bar shows where and how it will run).
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { SessionRail, Sidebar, TitleBar } from "./components/chrome"
import { Composer } from "./components/composer"
import { Transcript } from "./components/transcript"
import { Palette } from "./components/palette"
import { ChangesPane, FilesPane, PlanPane, TerminalPane } from "./components/panes"
import { activeSession, closePalette, closePane, newSession, openPalette, state, toggleExpanded, togglePane, toggleSidebar } from "./store"

// Shortcuts from the original: Ctrl+N new session, Ctrl+B sidebar, Ctrl+\ close the pane and
// Ctrl+Shift+\ expand it, Ctrl+` terminal, Ctrl+Shift+D changes, Ctrl+Shift+F files, Ctrl+K (and
// Ctrl+Shift+K) the command palette, Ctrl+Shift+M / Ctrl+Shift+I the mode and model menus.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const key = e.key.toLowerCase()
  const open = (menu: string) => (document.querySelector(`[data-menu="${menu}"]`) as HTMLElement | null)?.click()
  if (!e.shiftKey && key === "n") (e.preventDefault(), newSession())
  else if (!e.shiftKey && key === "b") (e.preventDefault(), toggleSidebar())
  else if ((e.code === "Backslash" || e.key === "\\" || e.key === "|") && state.pane) (e.preventDefault(), e.shiftKey ? toggleExpanded() : closePane())
  else if (!e.shiftKey && (e.code === "Backquote" || e.key === "`")) (e.preventDefault(), togglePane("terminal"))
  else if (e.shiftKey && key === "d" && activeSession()) (e.preventDefault(), togglePane("changes"))
  else if (e.shiftKey && key === "f") (e.preventDefault(), togglePane("files"))
  else if (key === "k") (e.preventDefault(), state.palette ? closePalette() : openPalette())
  else if (e.shiftKey && key === "m") (e.preventDefault(), open("mode"))
  else if (e.shiftKey && key === "i") (e.preventDefault(), open("model"))
})

/** The transcript follows new content while you're at the bottom, and opens at the bottom. */
function follow(scroller: HTMLDivElement) {
  let atBottom = true
  scroller.addEventListener("scroll", () => (atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80))
  const observer = new MutationObserver(() => {
    if (atBottom) scroller.scrollTop = scroller.scrollHeight
  })
  observer.observe(scroller, { childList: true, subtree: true, characterData: true })
  onCleanup(() => observer.disconnect())
  createEffect(
    on(
      () => state.activeId,
      () => {
        atBottom = true
        queueMicrotask(() => (scroller.scrollTop = scroller.scrollHeight))
      },
    ),
  )
}

export function App() {
  const [terminalOpened, setTerminalOpened] = createSignal(false)
  createEffect(() => state.pane === "terminal" && setTerminalOpened(true))
  return (
    <div class="cc-window">
      <TitleBar />
      <div class="cc-body">
        <Show when={state.sidebar}>
          <Sidebar />
        </Show>
        <main class="cc-main">
          <Show when={state.engine !== "ready"}>
            <div class="cc-banner">{state.engine === "reconnecting" ? "Reconnecting to Claude…" : "Starting Claude…"}</div>
          </Show>
          <div class="cc-scroll" ref={follow}>
            <Show when={activeSession()} fallback={<div class="cc-new" />}>
              {(s) => <Transcript session={s()} />}
            </Show>
          </div>
          <Composer />
          <Palette />
          <Show when={state.toast}>
            <div class="cc-toast" role="status">
              {state.toast}
            </div>
          </Show>
        </main>
        <Show when={!state.pane && activeSession() && state.rail}>
          <SessionRail />
        </Show>
        <Show when={state.pane === "plan"}>
          <PlanPane />
        </Show>
        <Show when={state.pane === "changes"}>
          <ChangesPane />
        </Show>
        <Show when={state.pane === "files"}>
          <FilesPane />
        </Show>
        {/* Shells keep running while the pane is closed, once opened. */}
        <Show when={terminalOpened()}>
          <TerminalPane hidden={state.pane !== "terminal"} />
        </Show>
      </div>
    </div>
  )
}
