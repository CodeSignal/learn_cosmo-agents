// Settings (S50–S58): a modal with a left nav (Settings · This computer · Customize) and a search
// field. Rows the candidate may change are their own preferences (prefs.ts) or the theme; the rest
// show what the task decided, disabled, with the reason as their description. Whole areas a task
// doesn't include (Cowork, Import & export) are replaced by a sentence.
import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { Icon, type IconName } from "../icons"
import { prefs, setPref, type PrefKey, type Prefs } from "../prefs"
import { closeSettings, FOLDER, openSettings, state, type SettingsPage } from "../store"

const NOT_HERE = "Not available in this task"
const SET = "Set by this task"
const DISABLED = "Disabled for this task"

type Option = { value: string; label: string; icon?: IconName }
type Control =
  | { kind: "segmented"; options: Option[]; value: () => string; set: (v: string) => void }
  | { kind: "select"; options: Option[]; value: () => string; set?: (v: string) => void; placeholder?: string }
  | { kind: "switch"; value: () => boolean; set?: (v: boolean) => void }
  | { kind: "text"; value: () => string; set?: (v: string) => void; placeholder?: string }
  | { kind: "value"; text: string }
  | { kind: "button"; label: string }
  | { kind: "custom"; render: () => JSX.Element }
type Row = { label: string; description?: string; control: Control; locked?: string; wide?: boolean }
type Section = { title?: string; rows: Row[] }

const NAV: { group: string; pages: { id: SettingsPage; title: string; icon: IconName }[] }[] = [
  {
    group: "Settings",
    pages: [
      { id: "general", title: "General", icon: "gear" },
      { id: "privacy", title: "Privacy", icon: "shield" },
      { id: "usage", title: "Usage", icon: "gauge" },
      { id: "code", title: "Cosmo Code", icon: "code" },
      { id: "cowork", title: "Cowork", icon: "listChecks" },
      { id: "import", title: "Import & export", icon: "download" },
    ],
  },
  { group: "This computer", pages: [{ id: "system", title: "System", icon: "monitor" }] },
  {
    group: "Customize",
    pages: [
      { id: "skills", title: "Skills", icon: "book" },
      { id: "connectors", title: "Connectors", icon: "blocks" },
      { id: "plugins", title: "Plugins", icon: "plug" },
    ],
  },
]
const titleOf = (id: SettingsPage) => NAV.flatMap((g) => g.pages).find((p) => p.id === id)!.title

/** A preference shown as a segmented control or a select. */
const pref = <K extends PrefKey>(key: K, options: Option[], kind: "segmented" | "select" = "segmented"): Control => ({
  kind,
  options,
  value: () => String(prefs[key]),
  set: (v) => setPref(key, v as Prefs[K]),
})
const fixed = (text: string): Control => ({ kind: "select", options: [{ value: text, label: text }], value: () => text })

function ThemeControl() {
  const theme = useTheme()
  const options = [
    { id: "system", label: "System", icon: "monitor" },
    { id: "light", label: "Light", icon: "sun" },
    { id: "dark", label: "Dark", icon: "moon" },
  ] as const
  return (
    <div class="cc-segmented cc-segmented-icons" role="radiogroup" aria-label="Theme">
      <For each={options}>
        {(o) => (
          <button role="radio" aria-label={o.label} title={o.label} aria-checked={theme.colorScheme() === o.id} onClick={() => theme.setColorScheme(o.id)}>
            <Icon name={o.icon} size={16} />
          </button>
        )}
      </For>
    </div>
  )
}

/** The code theme preview: a small diff in the theme it names. */
function CodePreview(props: { theme: "light" | "dark" }) {
  const lines: [string, string, string][] = [
    ["1", " ", "function greet(name: string) {"],
    ["2", "-", '  return "Hello, " + name;'],
    ["2", "+", "  return `Hello, ${name}!`;"],
    ["3", " ", "}"],
  ]
  return (
    <div class="cc-code-preview" data-theme-preview={props.theme} aria-hidden="true">
      <For each={lines}>
        {([no, sign, text]) => (
          <div class="cc-code-preview-line" data-kind={sign === "-" ? "del" : sign === "+" ? "add" : undefined}>
            <span class="cc-diff-no">{no}</span>
            <span class="cc-diff-sign">{sign}</span>
            <span>{text}</span>
          </div>
        )}
      </For>
    </div>
  )
}

const PAGES: Partial<Record<SettingsPage, Section[]>> = {
  general: [
    {
      title: "Profile",
      rows: [
        { label: "Avatar", control: { kind: "custom", render: () => <span class="cc-avatar cc-avatar-lg">r</span> } },
        {
          label: "What best describes your work?",
          control: pref(
            "work",
            ["Software engineering", "Data science", "Product management", "Design", "Research", "Education", "Other"].map((l) => ({ value: l, label: l })),
            "select",
          ),
        },
        {
          label: "Instructions for Claude",
          description: "Claude keeps these in mind in the sessions you start from now on.",
          wide: true,
          control: {
            kind: "custom",
            render: () => (
              <textarea
                class="cc-settings-textarea"
                aria-label="Instructions for Claude"
                placeholder="e.g. keep explanations brief and to the point"
                maxLength={4000}
                value={prefs.instructions}
                onInput={(e) => setPref("instructions", e.currentTarget.value)}
              />
            ),
          },
        },
      ],
    },
    {
      title: "Appearance",
      rows: [
        { label: "Theme", control: { kind: "custom", render: () => <ThemeControl /> } },
        {
          label: "Chat font",
          control: pref(
            "chatFont",
            [
              { value: "default", label: "Work Sans" },
              { value: "serif", label: "Serif" },
              { value: "system", label: "System" },
              { value: "legible", label: "Atkinson Hyperlegible" },
            ],
            "select",
          ),
        },
        {
          label: "Motion",
          description: "Reduce animation in streaming responses and other interface elements.",
          control: pref("motion", [
            { value: "system", label: "System" },
            { value: "reduced", label: "Reduced" },
          ]),
        },
      ],
    },
  ],
  code: [
    {
      title: "Code appearance",
      rows: [
        {
          label: "Code themes",
          wide: true,
          control: {
            kind: "custom",
            render: () => (
              <div class="cc-code-themes">
                <For each={["light", "dark"] as const}>
                  {(t) => (
                    <div>
                      <select class="cc-select" aria-label={t === "light" ? "Light code theme" : "Dark code theme"}>
                        <option>{t === "light" ? "Cosmo Light" : "Cosmo Dark"}</option>
                      </select>
                      <CodePreview theme={t} />
                    </div>
                  )}
                </For>
              </div>
            ),
          },
        },
        {
          label: "Code font",
          description: "Set a custom monospace font for code and terminal.",
          control: { kind: "text", value: () => prefs.codeFont, set: (v) => setPref("codeFont", v), placeholder: "e.g. JetBrains Mono" },
        },
      ],
    },
    {
      title: "Appearance",
      rows: [
        {
          label: "Interface font",
          description: "Font for the whole interface — menus, sidebars, and panels.",
          control: pref("interfaceFont", [
            { value: "default", label: "Work Sans" },
            { value: "system", label: "System" },
            { value: "legible", label: "Atkinson Hyperlegible" },
          ]),
        },
        {
          label: "Transcript text size",
          control: pref("textSize", [
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]),
        },
        {
          label: "Transcript width",
          description: "Maximum width of the transcript and composer columns.",
          control: pref("width", [
            { value: "narrow", label: "Narrow" },
            { value: "medium", label: "Medium" },
            { value: "wide", label: "Wide" },
          ]),
        },
        {
          label: "Default transcript view",
          description: "The view sessions open in. Picking a view from a session’s Transcript view menu changes only that session.",
          control: pref("transcriptView", [
            { value: "normal", label: "Normal" },
            { value: "thinking", label: "Thinking" },
            { value: "verbose", label: "Verbose" },
          ]),
        },
      ],
    },
    {
      title: "Sessions",
      rows: [
        {
          label: "Dynamic workflows",
          description: "Let Claude run multiple agents in parallel for complex tasks. Workflows can use a lot of your usage limit quickly.",
          control: { kind: "switch", value: () => false },
          locked: DISABLED,
        },
        {
          label: "Draw attention on notifications",
          description: "Flash the app icon when Claude needs your attention and the app isn’t focused.",
          control: { kind: "switch", value: () => false },
          locked: NOT_HERE,
        },
        {
          label: "Archive inactive sessions",
          description: "Automatically archive sessions after a period of no activity. Sessions that are running are never archived.",
          control: fixed("Never"),
          locked: SET,
        },
        {
          label: "Worktree location",
          description: "Where to store Git worktrees for isolated coding sessions on this computer.",
          control: fixed("Inside project"),
          locked: NOT_HERE,
        },
        {
          label: "Switch models in Cosmo Code on this computer",
          description: "When a message is flagged, switch without asking. When off, Claude asks first, or stops if it can’t ask.",
          control: { kind: "switch", value: () => false },
          locked: SET,
        },
        {
          label: "Output style",
          description: "How Claude structures its responses in Cosmo Code sessions. Applies to new sessions; the session menu can override it for a single session.",
          control: fixed("Default"),
          locked: SET,
        },
        {
          label: "Local sandbox",
          description: "Runs commands from Cosmo Code in an isolated sandbox. Applies to new sessions.",
          control: { kind: "switch", value: () => state.sandbox },
          locked: SET,
        },
        {
          label: "Strict sandbox mode",
          description: "Blocks commands that can’t run inside the sandbox instead of running them outside it or asking you.",
          control: { kind: "switch", value: () => state.sandbox },
          locked: SET,
        },
      ],
    },
    {
      title: "Browser",
      rows: [
        {
          label: "Browser tools",
          description: "Claude can start dev servers, open a live preview, and verify code changes with screenshots, snapshots, and DOM inspection.",
          control: { kind: "switch", value: () => false },
          locked: NOT_HERE,
        },
        {
          label: "Auto-open files Claude writes",
          description: "HTML, images, PDFs, and videos Claude writes open in the Preview pane.",
          control: { kind: "switch", value: () => false },
          locked: NOT_HERE,
        },
        {
          label: "Keep cookies",
          description: "Save cookies, local storage, and login sessions for Browser tabs across app restarts.",
          control: fixed("Until quit"),
          locked: NOT_HERE,
        },
      ],
    },
    {
      title: "Pull requests",
      rows: [
        {
          label: "Branch prefix",
          description: "Prefix added to branch names for both local and cloud sessions.",
          control: { kind: "text", value: () => "cosmo" },
          locked: NOT_HERE,
        },
      ],
    },
  ],
  system: [
    {
      title: "System",
      rows: [
        { label: "App version", control: { kind: "value", text: `Cosmo Code ${import.meta.env.VITE_VERSION ?? "0.1.0"}` } },
        { label: "Run on startup", description: "Automatically start Cosmo Code when you log in to your computer.", control: { kind: "switch", value: () => false }, locked: NOT_HERE },
        { label: "Quick Entry keyboard shortcut", description: "Quickly open Cosmo Code from anywhere.", control: { kind: "text", value: () => "Ctrl+Alt+Space" }, locked: NOT_HERE },
        { label: "System tray", description: "Show Cosmo Code in the system tray.", control: { kind: "switch", value: () => false }, locked: NOT_HERE },
        { label: "Storage", description: "See how much space Cosmo Code uses on this computer.", control: { kind: "button", label: "Manage" }, locked: NOT_HERE },
      ],
    },
  ],
}

function RowControl(props: { control: Control; label: string; locked?: string }) {
  const c = props.control
  const disabled = !!props.locked
  return (
    <Switch>
      <Match when={c.kind === "segmented" && c}>
        {(s) => (
          <div class="cc-segmented" role="radiogroup" aria-label={props.label}>
            <For each={s().options}>
              {(o) => (
                <button role="radio" aria-checked={s().value() === o.value} disabled={disabled} onClick={() => s().set(o.value)}>
                  {o.label}
                </button>
              )}
            </For>
          </div>
        )}
      </Match>
      <Match when={c.kind === "select" && c}>
        {(s) => (
          <select class="cc-select" aria-label={props.label} disabled={disabled || !s().set} onChange={(e) => s().set?.(e.currentTarget.value)}>
            <Show when={!s().value()}>
              <option value="" selected>
                Select
              </option>
            </Show>
            <For each={s().options}>
              {(o) => (
                <option value={o.value} selected={s().value() === o.value}>
                  {o.label}
                </option>
              )}
            </For>
          </select>
        )}
      </Match>
      <Match when={c.kind === "switch" && c}>
        {(s) => (
          <button class="cc-switch" role="switch" aria-label={props.label} aria-checked={s().value()} disabled={disabled || !s().set} onClick={() => s().set?.(!s().value())}>
            <span class="cc-switch-knob" />
          </button>
        )}
      </Match>
      <Match when={c.kind === "text" && c}>
        {(s) => (
          <input
            class="cc-settings-input"
            aria-label={props.label}
            placeholder={s().placeholder}
            value={s().value()}
            disabled={disabled || !s().set}
            onInput={(e) => s().set?.(e.currentTarget.value)}
          />
        )}
      </Match>
      <Match when={c.kind === "value" && c}>{(s) => <span class="cc-muted">{s().text}</span>}</Match>
      <Match when={c.kind === "button" && c}>
        {(s) => (
          <button class="cc-btn" disabled={disabled}>
            {s().label}
          </button>
        )}
      </Match>
      <Match when={c.kind === "custom" && c}>{(s) => s().render()}</Match>
    </Switch>
  )
}

function SettingRow(props: { row: Row }) {
  return (
    <div class="cc-setting" data-wide={props.row.wide ? "" : undefined} data-locked={props.row.locked ? "" : undefined}>
      <div class="cc-setting-text">
        <div class="cc-setting-label">{props.row.label}</div>
        <Show when={props.row.description}>
          <div class="cc-setting-desc">{props.row.description}</div>
        </Show>
        <Show when={props.row.locked}>
          <div class="cc-lock-note">
            <Icon name="lock" size={12} /> {props.row.locked}
          </div>
        </Show>
      </div>
      <RowControl control={props.row.control} label={props.row.label} locked={props.row.locked} />
    </div>
  )
}

function Sections(props: { sections: Section[] }) {
  return (
    <For each={props.sections}>
      {(section) => (
        <section class="cc-settings-section">
          <Show when={section.title}>
            <h3>{section.title}</h3>
          </Show>
          <For each={section.rows}>{(row) => <SettingRow row={row} />}</For>
        </section>
      )}
    </For>
  )
}

/** A whole area the task doesn't include. */
function Unavailable(props: { text: string }) {
  return (
    <div class="cc-settings-unavailable">
      <Icon name="lock" size={40} />
      <p>{props.text}</p>
    </div>
  )
}

/** Skills, Connectors, Plugins: nothing installed, and no way to add any in this task. */
function Customize(props: { title: string; first: string; blurb: string; none: string; discover?: boolean }) {
  const [directory, setDirectory] = createSignal(false)
  return (
    <div class="cc-customize">
      <div class="cc-customize-head">
        <Show when={directory()}>
          <button class="cc-icon-btn" aria-label="Back" onClick={() => setDirectory(false)}>
            <Icon name="back" size={16} />
          </button>
        </Show>
        <h2>{directory() ? "Directory" : props.title}</h2>
        <div class="cc-grow" />
        <Show when={props.discover && !directory()}>
          <label class="cc-settings-search cc-customize-search">
            <Icon name="search" size={14} />
            <input aria-label="Search skills and plugins" placeholder="Search skills and plugins" />
          </label>
          <button class="cc-btn cc-primary" onClick={() => setDirectory(true)}>
            Discover
          </button>
        </Show>
      </div>
      <Show
        when={!directory()}
        fallback={<p class="cc-settings-note">This task doesn’t provide plugins.</p>}
      >
        <div class="cc-customize-card">
          <div>
            <div class="cc-setting-label">{props.first}</div>
            <div class="cc-setting-desc">{props.blurb}</div>
          </div>
        </div>
        <div class="cc-customize-project">
          <span class="cc-setting-label">In this project</span> <span class="cc-count">0</span>
          <div class="cc-grow" />
          <span class="cc-chip">
            <Icon name="folder" size={14} /> {FOLDER}
          </span>
        </div>
        <p class="cc-customize-none">
          <Icon name="folder" size={16} /> {props.none}
        </p>
      </Show>
    </div>
  )
}

function Page(props: { page: SettingsPage }) {
  return (
    <Switch fallback={<Sections sections={PAGES[props.page] ?? []} />}>
      <Match when={props.page === "privacy"}>
        <div class="cc-privacy">
          <p>
            You’re running Claude through the model gateway this task provides. Your prompts, Claude’s responses, and the files and command
            output Claude reads to answer go through it.
          </p>
          <h4>What goes through the gateway</h4>
          <ul>
            <li>Your prompts and Claude’s responses</li>
            <li>Workspace files and command output Claude reads</li>
          </ul>
          <h4>What this app doesn’t send</h4>
          <ul>
            <li>Crash reports or usage metrics</li>
            <li>Update-check requests</li>
          </ul>
        </div>
      </Match>
      <Match when={props.page === "usage"}>
        <p class="cc-settings-note">This task sets how much Claude you can use. There’s no plan or usage limit to manage here.</p>
      </Match>
      <Match when={props.page === "cowork"}>
        <Unavailable text="Cowork isn’t enabled for this task." />
      </Match>
      <Match when={props.page === "import"}>
        <Unavailable text="Import isn’t enabled for this task." />
      </Match>
      <Match when={props.page === "skills"}>
        <Customize title="Skills" first="Add your first skills" blurb="Skills teach Claude how you work." none="No skills installed for this project yet." />
      </Match>
      <Match when={props.page === "connectors"}>
        <Customize
          title="Connectors"
          first="Add your first connectors"
          blurb="Connectors let Claude work with your team’s tools and data."
          none="No connectors for this project yet."
        />
      </Match>
      <Match when={props.page === "plugins"}>
        <Customize title="Plugins" first="Add your first plugins" blurb="Give Claude role-level expertise with plugins." none="No plugins installed for this project yet." discover />
      </Match>
    </Switch>
  )
}

/** Search: matching rows from every page, under the page's name. */
function Results(props: { query: string }) {
  const hits = createMemo(() => {
    const q = props.query.toLowerCase()
    return (Object.entries(PAGES) as [SettingsPage, Section[]][])
      .map(([page, sections]) => ({
        page,
        rows: sections.flatMap((s) => s.rows).filter((r) => `${r.label} ${r.description ?? ""}`.toLowerCase().includes(q)),
      }))
      .filter((h) => h.rows.length)
  })
  return (
    <Show when={hits().length} fallback={<p class="cc-settings-note">No settings match “{props.query}”.</p>}>
      <For each={hits()}>
        {(hit) => (
          <section class="cc-settings-section">
            <h3>{titleOf(hit.page)}</h3>
            <For each={hit.rows}>{(row) => <SettingRow row={row} />}</For>
          </section>
        )}
      </For>
    </Show>
  )
}

export function Settings() {
  return <Show when={state.settings}>{(page) => <Dialog page={page()} />}</Show>
}

function Dialog(props: { page: SettingsPage }) {
  const [query, setQuery] = createSignal("")
  return (
    <div class="cc-scrim cc-scrim-center" onMouseDown={(e) => e.target === e.currentTarget && closeSettings()}>
      <div
        class="cc-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return
          e.preventDefault()
          e.stopPropagation()
          if (query()) setQuery("")
          else closeSettings()
        }}
      >
        <nav class="cc-settings-nav" aria-label="Settings">
          <label class="cc-settings-search">
            <Icon name="search" size={15} />
            <input
              aria-label="Search settings"
              placeholder="Search"
              value={query()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </label>
          <For each={NAV}>
            {(group) => (
              <>
                <div class="cc-settings-group">{group.group}</div>
                <ul aria-label={group.group}>
                  <For each={group.pages}>
                    {(p) => (
                      <li>
                        <button
                          class="cc-settings-link"
                          aria-current={!query().trim() && props.page === p.id ? "page" : undefined}
                          onClick={() => (setQuery(""), openSettings(p.id))}
                        >
                          <Icon name={p.icon} size={16} /> {p.title}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </>
            )}
          </For>
        </nav>
        <div class="cc-settings-body">
          <button class="cc-icon-btn cc-settings-close" aria-label="Close" onClick={closeSettings}>
            <Icon name="close" size={16} />
          </button>
          <h2 class="cc-sr">{titleOf(props.page)}</h2>
          <Show when={query().trim()} fallback={<Page page={props.page} />}>
            <Results query={query().trim()} />
          </Show>
        </div>
      </div>
    </div>
  )
}
