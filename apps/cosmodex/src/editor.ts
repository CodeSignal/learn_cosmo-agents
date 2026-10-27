// A handle on the composer's input, so the command menu and menus elsewhere can focus it or
// add a file chip to it. The composer registers itself while it is mounted.
export type EditorHandle = {
  focus(): void
  /** Insert a file chip (workspace-relative path) at the caret, or at the end. */
  insertMention(path: string): void
  /** Type text at the caret (e.g. "@" to open the file popover). */
  type(text: string): void
  /** Start an "@" mention showing the workspace's files ("+" › Files and folders). */
  browseFiles(): void
}

let current: EditorHandle | undefined

export function registerEditor(handle: EditorHandle) {
  current = handle
  return () => {
    if (current === handle) current = undefined
  }
}

export const editor: EditorHandle = {
  focus: () => current?.focus(),
  insertMention: (path) => current?.insertMention(path),
  type: (text) => current?.type(text),
  browseFiles: () => current?.browseFiles(),
}
