// The candidate's own UI preferences (the settings that only change how Cosmodex looks or behaves
// in the browser). Kept in localStorage; reading or writing may fail in a sandboxed frame, so
// every access falls back to the defaults.
import { createStore } from "solid-js/store"

const KEY = "cosmodex.prefs.v1"

const DEFAULTS = {
  sendShortcut: "Enter" as "Enter" | "Ctrl+Enter",
  followUp: "Queue" as "Queue" | "Steer",
  plainTextComposer: false,
  showContextUsage: false,
  fullViewByDefault: false,
  bottomPanel: false,
  confetti: false,
  showMini: false,
  /** The sidebar's activity view (bell), and whether it shows each chat's last reply. */
  activityView: false,
  activityPreviews: true,
  /** Chats pinned to the top of the sidebar. */
  pinned: [] as string[],
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

export function togglePin(threadId: string) {
  setPref("pinned", prefs.pinned.includes(threadId) ? prefs.pinned.filter((id) => id !== threadId) : [...prefs.pinned, threadId])
}
