// The Cosmodex window: title bar, left rail, sidebar, and the main column (home, a thread, or one
// of the rail's pages).
import { Match, Show, Switch } from "solid-js"
import { Rail, Sidebar, TitleBar } from "./components/chrome"
import { RenameDialog } from "./components/chat-actions"
import { SettingsNav, SettingsPage } from "./components/settings"
import { Composer } from "./components/composer"
import { ThreadPage } from "./components/thread"
import { activeThread, PROJECT, state } from "./store"
import { onShortcut } from "./actions"
import { CommandMenu } from "./components/command-menu"

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

// Keyboard shortcuts run the same actions as the command menu (see actions.ts).
document.addEventListener("keydown", onShortcut)

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
          <CommandMenu />
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
