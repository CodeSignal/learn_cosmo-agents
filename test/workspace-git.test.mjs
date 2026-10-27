import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workspaceDiff } from "../server/workspace-git.mjs";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "calc.py"), "def add(a, b):\n    return a - b\n");
  git("add", "calc.py");
  git("commit", "-qm", "init");
  return { dir, git };
}

test("scopes: unstaged, staged and uncommitted (with untracked files as new files)", async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, "calc.py"), "def add(a, b):\n    return a + b\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello\n");
  fs.mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), ".codesignal/\n");
  fs.mkdirSync(path.join(dir, ".codesignal"));
  fs.writeFileSync(path.join(dir, ".codesignal", "agent-sim.json"), "{}");
  const unstaged = await workspaceDiff(dir, "unstaged");
  assert.match(unstaged.diff, /\+    return a \+ b/);
  assert.equal((await workspaceDiff(dir, "staged")).diff, "");
  git("add", "calc.py");
  assert.match((await workspaceDiff(dir, "staged")).diff, /\+    return a \+ b/);
  const all = (await workspaceDiff(dir, "uncommitted")).diff;
  assert.match(all, /\+    return a \+ b/);
  assert.match(all, /new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/notes.txt\n@@ -0,0 \+1,1 @@\n\+hello/);
  assert.doesNotMatch(all, /agent-sim/);
});

test("a folder that isn't a repo is reported, not an error; unknown scopes are refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
  assert.deepEqual(await workspaceDiff(dir, "uncommitted"), { scope: "uncommitted", available: false, diff: "" });
  await assert.rejects(workspaceDiff(dir, "everything"));
});

test("the views never write to the repository", async () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, "calc.py"), "changed\n");
  const before = fs.statSync(path.join(dir, ".git", "index")).mtimeMs;
  await workspaceDiff(dir, "uncommitted");
  await workspaceDiff(dir, "unstaged");
  assert.equal(fs.statSync(path.join(dir, ".git", "index")).mtimeMs, before);
});
