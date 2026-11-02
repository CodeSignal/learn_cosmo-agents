// OpenCosmo: what a task doesn't offer the candidate (connecting providers, adding custom ones,
// choosing which models to list) stays in the UI the way OpenCode shows something it can't
// change, rather than failing when the engine gateway refuses it.
import { Dialog } from "@opencode-ai/ui/dialog"

export const LOCKED = "Not available in this task"
/** Always true; a constant the type checker can't see through, so the code after an early return stays live. */
export const opencosmoLocked: boolean = true

const NOTE = "The task decides which providers and models you can use."

export function LockedDialog(props: { title: string }) {
  return (
    <Dialog title={props.title}>
      <p class="text-14-regular text-text-weak px-1 pb-2">
        {LOCKED}. {NOTE}
      </p>
    </Dialog>
  )
}

export function LockedPanel(props: { title: string }) {
  return (
    <div class="flex flex-col gap-2 px-6 py-8 max-w-[640px]">
      <h2 class="text-16-medium text-text-strong">{props.title}</h2>
      <p class="text-14-regular text-text-weak">
        {LOCKED}. {NOTE}
      </p>
    </div>
  )
}
