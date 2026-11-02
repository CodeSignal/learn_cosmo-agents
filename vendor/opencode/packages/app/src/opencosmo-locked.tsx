// OpenCosmo: what a task doesn't offer the candidate (connecting, disconnecting or adding
// providers) stays in the UI the way OpenCode shows something it can't change, rather than
// failing when the engine gateway refuses it. The task's providers and models still show.
import { Dialog } from "@opencode-ai/ui/dialog"

export const LOCKED = "Not available in this task"
/** Always true; a constant the type checker can't see through, so the code after an early return stays live. */
export const opencosmoLocked: boolean = true

const NOTE = "The task decides which providers and models you can use."

/** Where a connected provider would offer Disconnect. */
export const SET_BY_TASK = "Set by the task"

export function LockedDialog(props: { title: string }) {
  return <Dialog title={props.title} description={`${LOCKED}. ${NOTE}`} />
}
