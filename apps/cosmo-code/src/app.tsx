// The Cosmo Code window: title bar; sidebar · transcript with the composer · session rail or Plan
// pane. Without an open session the main column is a new session (the prompt bar shows where and
// how it will run).
import { createEffect, on, onCleanup, Show } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { Icon } from "./icons"
import { SessionRail, Sidebar, TitleBar } from "./components/chrome"
import { Composer } from "./components/composer"
import { Transcript } from "./components/transcript"
import { Palette } from "./components/palette"
import { activeSession, closePalette, copy, newSession, openPalette, showPlan, state, toggleSidebar } from "./store"

function PlanPane() {
  return (
    <aside class="cc-pane" aria-label="Plan">
      <header class="cc-pane-head">
        <span class="cc-pane-title">Plan</span>
        <div class="cc-grow" />
        <button class="cc-icon-btn cc-small" aria-label="Copy plan" onClick={() => void copy(state.plan ?? "", "Plan")}>
          <Icon name="copy" size={15} />
        </button>
        <button class="cc-icon-btn cc-small" aria-label="Close" aria-keyshortcuts="Control+\" onClick={() => showPlan(null)}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <div class="cc-pane-body">
        <Markdown class="cc-markdown" text={state.plan ?? ""} />
      </div>
    </aside>
  )
}

// Shortcuts from the original: Ctrl+N new session, Ctrl+B sidebar, Ctrl+\ close the pane,
// Ctrl+K (and Ctrl+Shift+K) the command palette, Ctrl+Shift+M / Ctrl+Shift+I the mode and model menus.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const key = e.key.toLowerCase()
  const open = (menu: string) => (document.querySelector(`[data-menu="${menu}"]`) as HTMLElement | null)?.click()
  if (!e.shiftKey && key === "n") (e.preventDefault(), newSession())
  else if (!e.shiftKey && key === "b") (e.preventDefault(), toggleSidebar())
  else if (!e.shiftKey && e.key === "\\" && state.plan !== null) (e.preventDefault(), showPlan(null))
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
        <Show when={state.plan !== null} fallback={<Show when={activeSession() && state.rail}><SessionRail /></Show>}>
          <PlanPane />
        </Show>
      </div>
    </div>
  )
}
