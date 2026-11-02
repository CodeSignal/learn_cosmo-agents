// OpenCosmo: the task's settings from the simulation server on the same origin (the shell's
// /api/session). Without it (e.g. running the app on its own) everything optional stays off.
import { createSignal } from "solid-js"

const [terminal, setTerminal] = createSignal(false)
const [autoMode, setAutoMode] = createSignal(false)
const [named, setNamed] = createSignal(false)

void fetch(new URL("/api/session", location.origin))
  .then((response) => (response.ok ? response.json() : undefined))
  .then((session) => {
    setTerminal(session?.terminal !== undefined && session.terminal !== "off")
    setAutoMode(session?.autoMode === true)
    setNamed(!!session?.agents?.find((a: { id: string }) => a.id === "opencosmo")?.models?.names)
  })
  .catch(() => setTerminal(false))

/** Whether this task gives the candidate a terminal pane. */
export const terminalEnabled = terminal

/** Whether the task gives the models cosmic names, in which case no vendor logo shows either. */
export const vendorHidden = named

/** Whether this task lets the candidate auto-accept permission requests (the original's toggle). */
export const autoAcceptEnabled = autoMode
