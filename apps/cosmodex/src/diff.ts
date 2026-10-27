// Unified diffs: parsed into files and lines for the Changes pane, and reverse-applied for Undo.
import { applyPatch, parsePatch, reversePatch } from "diff"
import { call } from "./engine"
import type { FsReadFileResponse } from "./protocol/v2/FsReadFileResponse"

export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string; oldNo?: number; newNo?: number }
export type DiffFile = { path: string; kind: "add" | "delete" | "update"; add: number; del: number; lines: DiffLine[] }

const strip = (p: string) => p.replace(/^[ab]\//, "")

/** Split a (git or plain) unified diff into files with numbered lines. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let oldNo = 0
  let newNo = 0
  let oldPath = ""
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = null
      continue
    }
    if (raw.startsWith("--- ")) {
      oldPath = raw.slice(4).trim()
      continue
    }
    if (raw.startsWith("+++ ")) {
      const newPath = raw.slice(4).trim()
      const kind = oldPath === "/dev/null" ? "add" : newPath === "/dev/null" ? "delete" : "update"
      file = { path: strip(kind === "delete" ? oldPath : newPath), kind, add: 0, del: 0, lines: [] }
      files.push(file)
      continue
    }
    if (!file) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      file.lines.push({ kind: "hunk", text: raw })
    } else if (raw.startsWith("+")) {
      file.add++
      file.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ })
    } else if (raw.startsWith("-")) {
      file.del++
      file.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ })
    } else if (raw.startsWith(" ")) {
      file.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files
}

export function totals(files: DiffFile[]) {
  return files.reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 })
}

const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))

/**
 * Undo a turn: reverse-apply its diff to the workspace through the engine's file calls (they run
 * as the agent and stay inside the workspace). Every file is checked before anything is written,
 * so a file changed since the turn leaves the workspace untouched.
 */
export async function undoDiff(workspace: string, text: string): Promise<{ ok: true } | { ok: false; path: string }> {
  const plan: { path: string; write?: string; remove?: boolean }[] = []
  for (const patch of parsePatch(text)) {
    const oldName = patch.oldFileName ?? ""
    const newName = patch.newFileName ?? ""
    const rel = strip(newName === "/dev/null" ? oldName : newName)
    const abs = `${workspace}/${rel}`
    if (oldName === "/dev/null") {
      plan.push({ path: abs, remove: true })
      continue
    }
    const current =
      newName === "/dev/null" ? "" : decode((await call<FsReadFileResponse>("fs/readFile", { path: abs })).dataBase64)
    const restored = applyPatch(current, reversePatch(patch))
    if (restored === false) return { ok: false, path: rel }
    plan.push({ path: abs, write: restored })
  }
  for (const step of plan) {
    if (step.remove) await call("fs/remove", { path: step.path, force: true })
    else await call("fs/writeFile", { path: step.path, dataBase64: encode(step.write!) })
  }
  return { ok: true }
}
