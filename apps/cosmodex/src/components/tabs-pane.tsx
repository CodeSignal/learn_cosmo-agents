// The tabs pane, right of the chat (S14): a strip of closable tabs with "+" New tab, then "Enter
// full view" and "Hide tabs". A New tab offers the in-app browser (not in a task) and Tools: Files
// (Ctrl+P) and Terminal (Ctrl+`, when the task has one). Every tab stays mounted while open, so a
// terminal keeps its shell when you switch away.
import { For, Match, Show, Switch } from "solid-js"
import { Icon, type IconName } from "../icons"
import { ChangesView } from "./changes"
import { FileView } from "./file-view"
import { TerminalView, terminateOnUnload } from "./terminal-view"
import {
  closeTab,
  closeTabs,
  newTab,
  openCommandMenu,
  openTerminal,
  selectTab,
  state,
  toggleFullView,
  type PaneTab,
} from "../store"

const LOCKED = "Not available in this task"

terminateOnUnload(() => state.tabs.list.filter((t) => t.kind === "terminal").map((t) => t.processId!))

function tabLabel(tab: PaneTab): { icon: IconName; label: string } {
  switch (tab.kind) {
    case "new":
      return { icon: "globe", label: "New tab" }
    case "changes":
      return { icon: "diff", label: "Changes" }
    case "file":
      return { icon: "file", label: tab.path!.split("/").pop()! }
    case "terminal":
      return { icon: "terminal", label: tab.title ?? "Terminal" }
  }
}

function NewTabView(props: { tab: PaneTab }) {
  return (
    <div class="cx-tab-body">
      <div class="cx-browser-bar">
        <button class="cx-icon-btn" aria-label="Back" disabled>
          <Icon name="chevronLeft" />
        </button>
        <button class="cx-icon-btn" aria-label="Next" disabled>
          <Icon name="chevronRight" />
        </button>
        <button class="cx-icon-btn" aria-label="Reload page" disabled>
          <Icon name="undo" />
        </button>
        <input class="cx-url" role="combobox" placeholder="Search or enter a URL" disabled title={`The browser: ${LOCKED.toLowerCase()}`} />
        <span class="cx-lock-note">
          <Icon name="lock" size={12} /> {LOCKED}
        </span>
      </div>
      <div class="cx-tools">
        <div class="cx-command-heading">Tools</div>
        <div class="cx-tools-grid">
          <button class="cx-tool-card" onClick={() => (closeTab(props.tab.id), openCommandMenu("files"))}>
            <Icon name="copy" size={15} /> Files <div class="cx-grow" /> <kbd class="cx-menu-kbd">Ctrl+P</kbd>
          </button>
          <button
            class="cx-tool-card"
            data-locked={state.terminal ? undefined : ""}
            disabled={!state.terminal}
            title={state.terminal ? undefined : LOCKED}
            onClick={() => {
              closeTab(props.tab.id)
              openTerminal()
            }}
          >
            <Icon name="terminal" size={15} /> Terminal <div class="cx-grow" />
            <Show when={state.terminal} fallback={<span class="cx-lock-note"><Icon name="lock" size={12} /> {LOCKED}</span>}>
              <kbd class="cx-menu-kbd">Ctrl+`</kbd>
            </Show>
          </button>
        </div>
      </div>
    </div>
  )
}

export function TabsPane() {
  return (
    <aside class="cx-tabs" aria-label="Tabs" hidden={!state.tabs.open || (state.page !== "home" && state.page !== "thread")}>
      <div class="cx-tab-strip" role="tablist">
        <For each={state.tabs.list}>
          {(tab) => {
            const info = () => tabLabel(tab)
            return (
              <div class="cx-tab" role="tab" aria-selected={state.tabs.active === tab.id} title={tab.path ?? info().label}>
                <button class="cx-tab-open" onClick={() => selectTab(tab.id)}>
                  <Icon name={info().icon} size={14} />
                  <span class="cx-tab-label">{info().label}</span>
                </button>
                <button class="cx-icon-btn cx-small cx-tab-close" aria-label={`Close ${info().label}`} onClick={() => closeTab(tab.id)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
            )
          }}
        </For>
        <button class="cx-icon-btn" aria-label="New tab" title="New tab Ctrl+T" onClick={newTab}>
          <Icon name="plus" />
        </button>
        <div class="cx-grow" />
        <button class="cx-icon-btn" aria-label={state.tabs.full ? "Exit full view" : "Enter full view"} title={state.tabs.full ? "Exit full view" : "Enter full view"} onClick={toggleFullView}>
          <Icon name={state.tabs.full ? "collapse" : "expand"} />
        </button>
        <button class="cx-icon-btn" aria-label="Hide tabs" title="Hide tabs Ctrl+Shift+B" onClick={closeTabs}>
          <Icon name="sidebar" />
        </button>
      </div>
      <For each={state.tabs.list}>
        {(tab) => (
          <div class="cx-tab-panel" role="tabpanel" hidden={state.tabs.active !== tab.id}>
            <Switch>
              <Match when={tab.kind === "new"}>
                <NewTabView tab={tab} />
              </Match>
              <Match when={tab.kind === "changes"}>
                <ChangesView />
              </Match>
              <Match when={tab.kind === "file"}>
                <FileView path={tab.path!} />
              </Match>
              <Match when={tab.kind === "terminal"}>
                <TerminalView tabId={tab.id} processId={tab.processId!} active={state.tabs.active === tab.id && state.tabs.open} />
              </Match>
            </Switch>
          </div>
        )}
      </For>
    </aside>
  )
}

