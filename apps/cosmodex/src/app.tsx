// The Cosmodex window: title bar, left rail, sidebar, and the main column (home, a thread, or one
// of the rail's pages).
import { Match, Show, Switch } from "solid-js"
import { Rail, Sidebar, TitleBar } from "./components/chrome"
import { RenameDialog } from "./components/chat-actions"
import { SettingsNav, SettingsPage } from "./components/settings"
import { Composer } from "./components/composer"
import { ThreadPage } from "./components/thread"
import { activeThread, archive, goHome, openChanges, openSettings, pin, PROJECT, startRename, state, toggleSidebar } from "./store"

function Mark() {
  // An orbit around a dot: Cosmodex's mark.
  return (
    <svg class="cx-mark" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="6" fill="currentColor" />
      <ellipse cx="24" cy="24" rx="20" ry="9" fill="none" stroke="currentColor" stroke-width="2.5" transform="rotate(-25 24 24)" />
    </svg>
  )
}

function Home() {
  return (
    <div class="cx-home">
      <div class="cx-home-center">
        <Mark />
        <h1 class="cx-home-title">
          What should we work on in <u>{PROJECT}</u>?
        </h1>
      </div>
      <div class="cx-bottom">
        <Composer />
      </div>
    </div>
  )
}

function EmptyPage(props: { title: string; empty: string }) {
  return (
    <div class="cx-page">
      <h1 class="cx-page-title">{props.title}</h1>
      <p class="cx-page-empty">{props.empty}</p>
    </div>
  )
}

// Shortcuts from the original: Ctrl+Shift+G opens Changes, Ctrl+Shift+S toggles the sidebar,
// Ctrl+, opens Settings, Ctrl+N starts a new chat; on an open chat Ctrl+Alt+R renames,
// Ctrl+Alt+P pins and Ctrl+Shift+A archives.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return
  const key = e.key.toLowerCase()
  const thread = state.page === "thread" ? activeThread() : undefined
  const run = (action: () => void) => {
    e.preventDefault()
    action()
  }
  if (e.shiftKey && !e.altKey) {
    if (key === "g") run(() => openChanges(activeThread()?.loaded?.at(-1)?.id ?? null))
    else if (key === "s") run(toggleSidebar)
    else if (key === "a" && thread) run(() => void archive(thread.id))
  } else if (e.altKey && !e.shiftKey && thread) {
    // Alt changes e.key on some layouts; e.code names the physical key.
    if (e.code === "KeyR") run(() => startRename(thread.id))
    else if (e.code === "KeyP") run(() => pin(thread.id))
  } else if (!e.shiftKey && !e.altKey) {
    if (key === ",") run(() => openSettings())
    else if (key === "n") run(goHome)
  }
})

export function App() {
  return (
    <div class="cx-window">
      <TitleBar />
      <div class="cx-body">
        <Rail />
        <Show when={state.page === "settings"} fallback={<Show when={state.sidebar}><Sidebar /></Show>}>
          <SettingsNav />
        </Show>
        <main class="cx-main">
          <Show when={state.engine !== "ready"}>
            <div class="cx-banner">{state.engine === "reconnecting" ? "Reconnecting to the agent…" : "Starting the agent…"}</div>
          </Show>
          <Switch>
            <Match when={state.page === "thread" && activeThread()}>{(thread) => <ThreadPage thread={thread()} />}</Match>
            <Match when={state.page === "scheduled"}>
              <EmptyPage title="Scheduled" empty="No scheduled tasks" />
            </Match>
            <Match when={state.page === "plugins"}>
              <EmptyPage title="Plugins" empty="Plugins aren't available in this task." />
            </Match>
            <Match when={state.page === "settings"}>
              <SettingsPage />
            </Match>
            <Match when={state.page === "explore"}>
              <EmptyPage title="Explore" empty="Nothing to explore in this task." />
            </Match>
            <Match when={true}>
              <Home />
            </Match>
          </Switch>
          <RenameDialog />
          <Show when={state.toast}>
            <div class="cx-toast" role="status">
              {state.toast}
            </div>
          </Show>
        </main>
      </div>
    </div>
  )
}
