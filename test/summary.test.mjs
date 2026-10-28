import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../scripts/summary.mjs", import.meta.url).pathname;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("run_solution's summary: setup, turns per agent, tools, answers, refusals, tampering, turn list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-"));
  const file = (name, text) => (fs.writeFileSync(path.join(dir, name), text), path.join(dir, name));
  const policy = file("policy.json", JSON.stringify({ agents: ["cosmo-code", "cosmodex"], default: "cosmo-code", allowSwitch: false, terminal: "sandboxed" }));
  const events = file(
    "events.jsonl",
    jsonl([
      { seq: 1, at: "T1", type: "turn", agent: "cosmo-code", sessionId: "aaaaaaaa-1", prompt: "fix it\n# not a heading" },
      { seq: 2, at: "T2", type: "permission-reply", agent: "cosmo-code", reply: "once" },
      { seq: 3, at: "T3", type: "blocked", agent: "cosmo-code", reason: "the permission mode" },
      { seq: 4, at: "T4", type: "turn-end", agent: "cosmo-code", sessionId: "aaaaaaaa-1", outcome: "completed", tools: { Bash: 2, Edit: 1 } },
      { seq: 5, at: "T5", type: "turn", agent: "cosmo-code", sessionId: "bbbbbbbb-2", prompt: "again" },
      { seq: 6, at: "T6", type: "turn-end", agent: "cosmo-code", sessionId: "aaaaaaaa-1", outcome: "completed", tools: {}, followUp: true },
      "not json",
    ]).replace('"not json"', "not json"),
  );
  const supervisor = file("supervisor.jsonl", jsonl([{ type: "tamper", service: "codex" }, { type: "exit", service: "codex" }]));
  const out = execFileSync(process.execPath, [script, "--policy", policy, "--events", events, "--supervisor", supervisor], { encoding: "utf8" });
  assert.equal(
    out,
    [
      "## SUMMARY",
      "Agents: cosmo-code (default), cosmodex; switching off; terminal sandboxed",
      "Turns (cosmo-code): 2 in 2 sessions; ended: completed 1; engine follow-ups: 1",
      "Tools (cosmo-code): Bash 2, Edit 1",
      "Turns (cosmodex): 0 in 0 sessions; ended: none",
      "Tools (cosmodex): none",
      "Permission answers: once 1",
      "Blocked attempts: the permission mode 1",
      "Agent switches: 0",
      "Tampering: codex port taken 1",
      "Engine restarts: 1",
      "",
      "## TURNS",
      'T1 cosmo-code aaaaaaaa prompt "fix it\\n# not a heading" -> completed; tools: Bash 2, Edit 1',
      'T5 cosmo-code bbbbbbbb prompt "again" -> no end recorded',
      "",
    ].join("\n"),
  );
});

test("the summary still prints without any records", () => {
  const out = execFileSync(process.execPath, [script, "--policy", "/nonexistent", "--events", "/nonexistent", "--supervisor", "/nonexistent"], { encoding: "utf8" });
  assert.match(out, /^## SUMMARY\nAgents: \(no applied policy\)\n/);
  assert.match(out, /## TURNS\n\(none\)\n$/);
});
