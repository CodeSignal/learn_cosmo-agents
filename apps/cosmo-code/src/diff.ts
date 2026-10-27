// Unified diffs (the workspace's git diff) parsed into files and numbered lines for the Changes pane.

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
