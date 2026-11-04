// The Cosmo Code window: title bar; sidebar · transcript with the composer · the session rail, or a
// pane (Plan, Background tasks, Changes, Terminal, Preview, Files) in its place. Without an open session the
// main column is a new session (the prompt bar shows where and how it will run). Settings and the
// keyboard shortcuts open as dialogs over it.
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { SessionRail, Sidebar, TitleBar } from "./components/chrome"
import { Composer } from "./components/composer"
import { Transcript } from "./components/transcript"
import { Palette } from "./components/palette"
import { ChangesPane, FilesPane, PlanPane, PreviewPane, TasksPane, TerminalPane } from "./components/panes"
import { Settings } from "./components/settings"
import { Shortcuts } from "./components/shortcuts"
import { cycleView } from "./prefs"
import {
  activeSession,
  archive,
  closePalette,
  closePane,
  newSession,
  openPalette,
  openHelp,
  openSettings,
  state,
  stepSession,
  toggleExpanded,
  togglePane,
  reloadPreview,
  toggleShortcuts,
  toggleSidebar,
} from "./store"
import { COSMO } from "./engine"

/** F6 / Shift+F6: focus the next (previous) page area — sidebar, the prompt, the right column. */
function focusArea(by: 1 | -1) {
  const areas = [".cc-sidebar", ".cc-prompt", ".cc-pane:not([hidden]), .cc-rail"]
    .map((sel) => document.querySelector(sel) as HTMLElement | null)
    .filter((el): el is HTMLElement => !!el)
  if (!areas.length) return
  const at = areas.findIndex((el) => el.contains(document.activeElement))
  const area = areas[(at + by + areas.length) % areas.length]!
  const target = area.matches("button, input, textarea, [contenteditable], [tabindex]") ? area : area.querySelector<HTMLElement>("button:not(:disabled), input, textarea, [contenteditable], [tabindex]")
  target?.focus()
}

// Shortcuts from the original: Ctrl+N (Ctrl+Shift+N) new session, Ctrl+B sidebar, Ctrl+\ close the
// pane and Ctrl+Shift+\ expand it, Ctrl+` terminal, Ctrl+Shift+D changes, Ctrl+Shift+F files,
// Ctrl+Shift+P preview (F5 reloads it), Ctrl+K (and Ctrl+Shift+K) the command palette,
// Ctrl+Shift+M / Ctrl+Shift+I the mode and model menus, Ctrl+, settings, Ctrl+/ shortcuts, Ctrl+O
// transcript view, Ctrl+Shift+] / [ (Ctrl+Tab) next and previous session, Ctrl+Shift+Backspace
// archive, F6 page areas, F1 help.
document.addEventListener("keydown", (e) => {
  if (e.key === "F6" && !e.ctrlKey && !e.altKey) return void (e.preventDefault(), focusArea(e.shiftKey ? -1 : 1))
  if (e.key === "F1" && !e.ctrlKey && !e.altKey) return void (e.preventDefault(), openHelp())
  if (e.key === "F5" && state.pane === "preview" && !e.ctrlKey) return void (e.preventDefault(), reloadPreview())
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const key = e.key.toLowerCase()
  const open = (menu: string) => (document.querySelector(`[data-menu="${menu}"]`) as HTMLElement | null)?.click()
  const session = activeSession()
  if (key === "n") (e.preventDefault(), newSession())
  else if (!e.shiftKey && (key === "," || e.code === "Comma")) (e.preventDefault(), state.settings ? undefined : openSettings())
  else if (!e.shiftKey && (key === "/" || e.code === "Slash")) (e.preventDefault(), toggleShortcuts())
  else if (!e.shiftKey && key === "o" && session) (e.preventDefault(), cycleView(session.id))
  else if (e.shiftKey && key === "backspace" && session) (e.preventDefault(), void archive(session.id))
  else if (e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) (e.preventDefault(), stepSession(e.code === "BracketRight" ? 1 : -1))
  else if (key === "tab") (e.preventDefault(), stepSession(e.shiftKey ? -1 : 1))
  else if (!e.shiftKey && key === "b") (e.preventDefault(), toggleSidebar())
  else if ((e.code === "Backslash" || e.key === "\\" || e.key === "|") && state.pane) (e.preventDefault(), e.shiftKey ? toggleExpanded() : closePane())
  else if (!e.shiftKey && (e.code === "Backquote" || e.key === "`")) (e.preventDefault(), togglePane("terminal"))
  else if (e.shiftKey && key === "d" && activeSession()) (e.preventDefault(), togglePane("changes"))
  else if (e.shiftKey && key === "f") (e.preventDefault(), togglePane("files"))
  else if (e.shiftKey && key === "p" && session) (e.preventDefault(), togglePane("preview"))
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
            <Show
              when={activeSession()}
              fallback={
                <div class="cc-new">
                  {/* Cosmo, the simulation's mascot (pixel art, served by the shell). */}
                  <img class="cc-mascot" src={`${COSMO}/cosmo.svg`} alt="" />
                </div>
              }
            >
              {(s) => <Transcript session={s()} />}
            </Show>
          </div>
          <Composer />
          <Palette />
          <Settings />
          <Shortcuts />
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
        <Show when={state.pane === "tasks"}>
          <TasksPane />
        </Show>
        <Show when={state.pane === "preview"}>
          <PreviewPane />
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
