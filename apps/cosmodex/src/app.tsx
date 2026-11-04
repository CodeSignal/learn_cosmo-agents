// The Cosmodex window: title bar, left rail, sidebar, and the main column (home, a thread, or one
// of the rail's pages).
import { Match, Show, Switch } from "solid-js"
import { Rail, Sidebar, TitleBar } from "./components/chrome"
import { RenameDialog } from "./components/chat-actions"
import { SettingsNav, SettingsPage } from "./components/settings"
import { Composer, ProjectPopover } from "./components/composer"
import { ThreadPage } from "./components/thread"
import { activeThread, PROJECT, state } from "./store"
import { onShortcut } from "./actions"
import { CommandMenu } from "./components/command-menu"
import { TabsPane } from "./components/tabs-pane"
import { TableDialog } from "./components/rich-markdown"
import { TabsToggle } from "./components/thread"
import { COSMO } from "./engine"

function Mark() {
  // Cosmo, the simulation's mascot (pixel art, served by the shell), where the original shows its mark.
  return <img class="cx-mark" src={`${COSMO}/cosmo.svg`} alt="" />
}

/** Home and chats show the tabs pane; other pages don't. */
const chatPage = () => state.page === "home" || state.page === "thread"

function Home() {
  return (
    <div class="cx-home">
      <div class="cx-home-actions">
        <TabsToggle />
      </div>
      <div class="cx-home-center">
        <Mark />
        <h1 class="cx-home-title">
          What should we work on in{" "}
          <ProjectPopover
            placement="below"
            trigger={(toggle) => (
              <button class="cx-home-project" aria-label={`Change project: ${PROJECT}`} onClick={toggle}>
                {PROJECT}
              </button>
            )}
          />
          ?
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
          <div class="cx-split-main">
          <div class="cx-page-col" hidden={state.tabs.open && state.tabs.full && chatPage()}>
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
          </div>
          {/* Kept mounted while it has tabs (a terminal keeps its shell); shown next to Home and chats. */}
          <Show when={state.tabs.list.length}>
            <TabsPane />
          </Show>
          </div>
          <RenameDialog />
          <CommandMenu />
          <TableDialog />
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
