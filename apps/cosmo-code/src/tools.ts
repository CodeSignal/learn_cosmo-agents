// How tool calls read in the transcript and in permission prompts, as in the original: a row
// labelled by what the tool does ("Running …" → "Ran …", "Created greet.js +5 −0"), and a prompt
// "Allow Claude to run …?" / "Allow Claude to write greet.js?".
import { diffLines } from "diff"

export type ToolUse = { id: string; name: string; input: any }
export type ToolResult = { content: unknown; is_error?: boolean }

export const base = (p: string) => String(p ?? "").split("/").pop() || String(p ?? "")

/** The text of a tool result (string, or text blocks). */
export function resultText(result: ToolResult | undefined) {
  const c = result?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((b: any) => (typeof b === "string" ? b : (b?.text ?? ""))).join("\n")
  return ""
}

// First word of a description → its -ing and past forms ("Run scripted command").
const VERBS: Record<string, [string, string]> = {
  run: ["Running", "Ran"], list: ["Listing", "Listed"], check: ["Checking", "Checked"], install: ["Installing", "Installed"],
  create: ["Creating", "Created"], build: ["Building", "Built"], test: ["Testing", "Tested"], show: ["Showing", "Showed"],
  find: ["Finding", "Found"], search: ["Searching", "Searched"], read: ["Reading", "Read"], print: ["Printing", "Printed"],
  start: ["Starting", "Started"], stop: ["Stopping", "Stopped"], remove: ["Removing", "Removed"], delete: ["Deleting", "Deleted"],
  make: ["Making", "Made"], get: ["Getting", "Got"], count: ["Counting", "Counted"], execute: ["Executing", "Executed"],
}

function tenses(description: string): [string, string] {
  const [first = "", ...rest] = description.trim().split(/\s+/)
  const verb = VERBS[first.toLowerCase()]
  const tail = rest.join(" ")
  if (verb) return [`${verb[0]} ${tail}`.trim(), `${verb[1]} ${tail}`.trim()]
  return [`Running ${description}`, `Ran ${description}`]
}

/** Lines added and removed by a file tool's input. */
export function editStats(tool: ToolUse): { add: number; del: number } {
  const i = tool.input ?? {}
  const count = (before: string, after: string) => {
    let add = 0
    let del = 0
    for (const part of diffLines(before, after)) {
      if (part.added) add += part.count ?? 0
      else if (part.removed) del += part.count ?? 0
    }
    return { add, del }
  }
  if (tool.name === "Write") return count("", String(i.content ?? ""))
  if (tool.name === "Edit") return count(String(i.old_string ?? ""), String(i.new_string ?? ""))
  if (tool.name === "MultiEdit") {
    return (i.edits ?? []).reduce((acc: { add: number; del: number }, e: any) => {
      const s = count(String(e.old_string ?? ""), String(e.new_string ?? ""))
      return { add: acc.add + s.add, del: acc.del + s.del }
    }, { add: 0, del: 0 })
  }
  return { add: 0, del: 0 }
}

export const isEdit = (name: string) => name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit"

/** The row's label while running and once done. */
export function rowLabel(tool: ToolUse, result: ToolResult | undefined): { running: string; done: string; target?: string } {
  const i = tool.input ?? {}
  switch (tool.name) {
    case "Bash": {
      const [running, done] = tenses(String(i.description || i.command || "command"))
      return { running, done }
    }
    case "Write": {
      const created = !/updated|overwr/i.test(resultText(result))
      return { running: "Creating", done: created ? "Created" : "Wrote", target: base(i.file_path) }
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { running: "Editing", done: "Edited", target: base(i.file_path ?? i.notebook_path) }
    case "Read":
      return { running: "Reading", done: "Read", target: base(i.file_path) }
    case "Grep":
      return { running: "Searching for", done: "Searched for", target: String(i.pattern ?? "") }
    case "Glob":
      return { running: "Finding", done: "Found", target: String(i.pattern ?? "") }
    case "ExitPlanMode":
      return { running: "Proposing plan", done: "Proposed plan" }
    case "Task":
    case "Agent":
      return { running: "Running agent", done: "Ran agent", target: i.description ? `· ${i.description}` : undefined }
    case "TodoWrite":
      return { running: "Updating the task list", done: "Updated the task list" }
    default: {
      const name = tool.name.startsWith("mcp__") ? tool.name.split("__").slice(2).join(" ") : tool.name
      return { running: `Using ${name}`, done: `Used ${name}` }
    }
  }
}

/** How a finished call ended: blocked by policy, denied by the candidate, failed, or fine. */
export function outcome(tool: ToolUse, result: ToolResult | undefined): "blocked" | "denied" | "failed" | null {
  if (!result?.is_error) return null
  const text = resultText(result)
  if (/has been denied|denied by|blocked by|disabled for this session|not allowed by/i.test(text) && !/The user/i.test(text)) return "blocked"
  if (tool.name === "ExitPlanMode" || /The user (doesn't want|denied|rejected|skipped)/i.test(text)) return "denied"
  return "failed"
}

/** "Allow Claude to <verb> <target>?" with the target line and the preview the card shows. */
export function promptText(toolName: string, input: any, displayName?: string, description?: string) {
  const i = input ?? {}
  switch (toolName) {
    case "Bash":
      return { verb: "run", target: String(i.description || description || "this command"), detail: String(i.command ?? "") }
    case "Write":
      return { verb: "write", target: base(i.file_path), detail: String(i.file_path ?? "") }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: "edit", target: base(i.file_path ?? i.notebook_path), detail: String(i.file_path ?? i.notebook_path ?? "") }
    case "SandboxNetworkAccess":
      return { verb: "connect to", target: String(i.host ?? "the network"), detail: "" }
    default:
      return { verb: "use", target: displayName ?? toolName, detail: Object.keys(i).length ? JSON.stringify(i, null, 2) : "" }
  }
}
