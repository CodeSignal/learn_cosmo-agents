// Read-only git views of the task workspace for the agent UIs' change lists ("Uncommitted",
// "Unstaged", "Staged", and "All changes vs main": everything since the branch left main). Runs as the server's own user: no writes (optional locks off), bounded
// time and output. The workspace belongs to the session user, hence the safe.directory entry.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const SCOPES = ["uncommitted", "unstaged", "staged", "base"];
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_UNTRACKED_FILE = 256 * 1024;

function git(workspace, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", `safe.directory=${workspace}`, "-c", "core.quotepath=off", ...args],
      { cwd: workspace, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", HOME: "/nonexistent" }, timeout: 10_000, maxBuffer: MAX_OUTPUT },
      (error, stdout) => resolve(error ? { ok: false, out: "" } : { ok: true, out: stdout }),
    );
  });
}

/** A new-file diff for an untracked text file (git doesn't diff those). */
function untrackedDiff(workspace, rel) {
  const file = path.join(workspace, rel);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_UNTRACKED_FILE) return "";
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("\0")) return "";
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const body = lines.map((l) => `+${l}`).join("\n");
    const tail = text.endsWith("\n") ? "" : "\n\\ No newline at end of file";
    return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}${tail}\n`;
  } catch {
    return "";
  }
}

/** The unified diff for a scope, or { available: false } when the workspace isn't a git repo. */
export async function workspaceDiff(workspace, scope) {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope ${scope}`);
  if (!(await git(workspace, ["rev-parse", "--is-inside-work-tree"])).ok) return { scope, available: false, diff: "" };
  const flags = ["--no-color", "--no-ext-diff"];
  if (scope === "unstaged") return { scope, available: true, diff: (await git(workspace, ["diff", ...flags])).out };
  if (scope === "staged") return { scope, available: true, diff: (await git(workspace, ["diff", "--cached", ...flags])).out };
  const hasHead = (await git(workspace, ["rev-parse", "--verify", "-q", "HEAD"])).ok;
  // "vs main": from where this branch left the base branch (main, else master); without one, HEAD.
  let from = hasHead ? "HEAD" : null;
  let base = null;
  if (scope === "base" && hasHead) {
    for (const name of ["main", "master"]) {
      if (!(await git(workspace, ["rev-parse", "--verify", "-q", `refs/heads/${name}`])).ok) continue;
      const fork = (await git(workspace, ["merge-base", `refs/heads/${name}`, "HEAD"])).out.trim();
      if (fork) {
        from = fork;
        base = name;
      }
      break;
    }
  }
  const tracked = from
    ? (await git(workspace, ["diff", from, ...flags])).out
    : (await git(workspace, ["diff", "--cached", ...flags])).out + (await git(workspace, ["diff", ...flags])).out;
  const others = (await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])).out.split("\0").filter(Boolean);
  return { scope, available: true, ...(scope === "base" ? { base } : {}), diff: tracked + others.map((rel) => untrackedDiff(workspace, rel)).join("") };
}
