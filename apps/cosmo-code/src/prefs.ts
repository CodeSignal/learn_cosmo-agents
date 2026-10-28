// The candidate's own UI preferences (Settings rows that only change how Cosmo Code looks or
// behaves in the browser). Kept in localStorage; reading or writing may fail in a sandboxed frame,
// so every access falls back to the defaults. They're applied to the page as CSS variables and
// data attributes on <html>.
import { createEffect, createRoot } from "solid-js"
import { createStore } from "solid-js/store"

const KEY = "cosmo-code.prefs.v1"

export type TranscriptView = "normal" | "thinking" | "verbose"

const DEFAULTS = {
  /** General → Profile. Kept here only: there is no account to send them to. */
  work: "",
  instructions: "",
  chatFont: "default" as "default" | "serif" | "system" | "legible",
  motion: "system" as "system" | "reduced",
  /** Cosmo Code → appearance. */
  codeFont: "",
  interfaceFont: "default" as "default" | "system" | "legible",
  textSize: "medium" as "small" | "medium" | "large",
  width: "narrow" as "narrow" | "medium" | "wide",
  transcriptView: "normal" as TranscriptView,
  /** Cosmo Code → Browser: HTML, images, PDFs and videos Claude writes open in Preview. */
  autoOpen: true,
  /** A session's own view (its Transcript view menu), by session id. */
  sessionViews: {} as Record<string, TranscriptView>,
  /** The sidebar (Group and sort, S11): order, what rows show, and the candidate's own sections. */
  sortBy: "updated" as SortBy,
  sortDir: "desc" as "desc" | "asc",
  showMetadata: false,
  showEmptyGroups: false,
  sections: [] as { id: string; name: string }[],
  /** The section a session was moved to, by session id. */
  sectionOf: {} as Record<string, string>,
  /** Pinned sessions (on top), and sessions marked unread. */
  pinned: [] as string[],
  unread: [] as string[],
  /** Sidebar groups and session rail cards the candidate collapsed. */
  collapsed: {} as Record<string, true>,
}

export type SortBy = "updated" | "created" | "name"
/** The sidebar settings Reset to defaults puts back. */
export const SIDEBAR_DEFAULTS = { sortBy: DEFAULTS.sortBy, sortDir: DEFAULTS.sortDir, showMetadata: DEFAULTS.showMetadata, showEmptyGroups: DEFAULTS.showEmptyGroups }

export type Prefs = typeof DEFAULTS
export type PrefKey = keyof Prefs

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

const [prefs, setPrefsStore] = createStore<Prefs>(load())
export { prefs }

export function setPref<K extends PrefKey>(key: K, value: Prefs[K]) {
  setPrefsStore(key, value as never)
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch (error) {
    console.warn("Preferences could not be saved", error)
  }
}

export const viewOf = (sessionId: string | null | undefined): TranscriptView =>
  (sessionId && prefs.sessionViews[sessionId]) || prefs.transcriptView

export function setSessionView(sessionId: string, view: TranscriptView) {
  setPref("sessionViews", { ...prefs.sessionViews, [sessionId]: view })
}

const toggleIn = (list: string[], id: string, on: boolean) => (on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id))
export const setPinned = (id: string, on: boolean) => setPref("pinned", toggleIn(prefs.pinned, id, on))
export const setUnread = (id: string, on: boolean) => {
  if (prefs.unread.includes(id) !== on) setPref("unread", toggleIn(prefs.unread, id, on))
}
export const toggleCollapsed = (key: string) => {
  const { [key]: was, ...rest } = prefs.collapsed
  setPref("collapsed", was ? rest : { ...rest, [key]: true })
}

/** A new section (named "New section" until renamed); with a session, that session moves into it. */
export function addSection(sessionId?: string) {
  const id = Math.random().toString(36).slice(2, 10)
  setPref("sections", [...prefs.sections, { id, name: "New section" }])
  if (sessionId) moveToSection(sessionId, id)
  return id
}
export const renameSection = (id: string, name: string) =>
  setPref("sections", prefs.sections.map((s) => (s.id === id ? { ...s, name: name.trim() || s.name } : s)))
export function deleteSection(id: string) {
  setPref("sections", prefs.sections.filter((s) => s.id !== id))
  setPref("sectionOf", Object.fromEntries(Object.entries(prefs.sectionOf).filter(([, sec]) => sec !== id)))
}
export function moveToSection(sessionId: string, sectionId: string | null) {
  const { [sessionId]: _, ...rest } = prefs.sectionOf
  setPref("sectionOf", sectionId ? { ...rest, [sessionId]: sectionId } : rest)
}

const VIEWS: TranscriptView[] = ["normal", "thinking", "verbose"]
/** Ctrl+O: the next view for this session. */
export function cycleView(sessionId: string) {
  setSessionView(sessionId, VIEWS[(VIEWS.indexOf(viewOf(sessionId)) + 1) % VIEWS.length]!)
}

const LEGIBLE = "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap"
const FONTS = {
  default: 'var(--cc-font-default)',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  legible: '"Atkinson Hyperlegible", var(--cc-font-default)',
}

/** Apply the preferences to the page, and keep them applied. */
export function applyPrefs() {
  createRoot(() =>
    createEffect(() => {
      const root = document.documentElement
      if ((prefs.chatFont === "legible" || prefs.interfaceFont === "legible") && !document.querySelector(`link[href="${LEGIBLE}"]`)) {
        document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: LEGIBLE }))
      }
      root.style.setProperty("--cc-font", FONTS[prefs.interfaceFont])
      root.style.setProperty("--cc-chat-font", prefs.chatFont === "default" ? "var(--cc-font)" : FONTS[prefs.chatFont])
      if (prefs.codeFont.trim()) root.style.setProperty("--cc-mono", `"${prefs.codeFont.trim().replace(/["\\]/g, "")}", var(--cc-mono-default)`)
      else root.style.removeProperty("--cc-mono")
      root.dataset.textSize = prefs.textSize
      root.dataset.width = prefs.width
      root.dataset.motion = prefs.motion
    }),
  )
}
