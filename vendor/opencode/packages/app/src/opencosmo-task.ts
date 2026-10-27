// OpenCosmo: the task's settings from the simulation server on the same origin (the shell's
// /api/session). Without it (e.g. running the app on its own) everything optional stays off.
import { createSignal } from "solid-js"

const [terminal, setTerminal] = createSignal(false)

void fetch(new URL("/api/session", location.origin))
  .then((response) => (response.ok ? response.json() : undefined))
  .then((session) => setTerminal(session?.terminal !== undefined && session.terminal !== "off"))
  .catch(() => setTerminal(false))

/** Whether this task gives the candidate a terminal pane. */
export const terminalEnabled = terminal
