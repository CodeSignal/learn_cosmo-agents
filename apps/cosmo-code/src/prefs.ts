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
  /** A session's own view (its Transcript view menu), by session id. */
  sessionViews: {} as Record<string, TranscriptView>,
}

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
