#!/usr/bin/env node
// The summary run_solution.sh prints first: what the task allowed and what happened, from the
// records the session user can't change (the applied policy, the server's event log, the
// supervisor's log). Deterministic: the same records always print the same lines.
//   node summary.mjs [--policy file] [--events file] [--supervisor file]
import fs from "node:fs";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const STATE = process.env.AGENTSIM_STATE ?? "/var/lib/agentsim";
const policyFile = arg("policy", process.env.AGENTSIM_POLICY ?? "/etc/agentsim/policy.json");
const eventsFile = arg("events", `${STATE}/events/events.jsonl`);
const supervisorFile = arg("supervisor", `${STATE}/supervisor.jsonl`);

const lines = (file) => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};
let policy = null;
try {
  policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
} catch {
  /* no applied policy */
}

/** "a 2, b 1": counts, most first, then by name. */
const tally = (counts) =>
  Object.entries(counts)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "none";
const add = (counts, key, n = 1) => ((counts[key] = (counts[key] ?? 0) + n), counts);

const events = lines(eventsFile);
const supervisor = lines(supervisorFile);
const agents = policy?.agents ?? [...new Set(events.map((e) => e.agent).filter(Boolean))];

const out = ["## SUMMARY"];
out.push(
  policy
    ? `Agents: ${agents.map((a) => (a === policy.default ? `${a} (default)` : a)).join(", ")}; switching ${policy.allowSwitch ? "allowed" : "off"}; terminal ${policy.terminal ?? "off"}`
    : "Agents: (no applied policy)",
);
for (const agent of agents) {
  const turns = events.filter((e) => e.type === "turn" && e.agent === agent);
  const ends = events.filter((e) => e.type === "turn-end" && e.agent === agent);
  // Turns the engine started by itself (after a background task ended) aren't the candidate's.
  const outcomes = ends.filter((e) => !e.followUp).reduce((c, e) => add(c, e.outcome), {});
  const followUps = ends.filter((e) => e.followUp).length;
  const tools = ends.reduce((c, e) => (Object.entries(e.tools ?? {}).forEach(([t, n]) => add(c, t, n)), c), {});
  const sessions = new Set(turns.map((e) => e.sessionId)).size;
  out.push(`Turns (${agent}): ${turns.length} in ${sessions} session${sessions === 1 ? "" : "s"}; ended: ${tally(outcomes)}${followUps ? `; engine follow-ups: ${followUps}` : ""}`);
  out.push(`Tools (${agent}): ${tally(tools)}`);
}
const replies = events.filter((e) => e.type === "permission-reply").reduce((c, e) => add(c, String(e.reply)), {});
out.push(`Permission answers: ${tally(replies)}`);
const blocked = events.filter((e) => e.type === "blocked").reduce((c, e) => add(c, String(e.reason ?? "unknown")), {});
out.push(`Blocked attempts: ${tally(blocked)}`);
out.push(`Agent switches: ${events.filter((e) => e.type === "switch").length}`);
const tamper = supervisor.filter((e) => e.type === "tamper");
// The supervisor killed something holding a service's port (an agent squatting it).
out.push(`Tampering: ${tamper.length ? tally(tamper.reduce((c, e) => add(c, `${e.service ?? "service"} port taken`), {})) : "none"}`);
out.push(`Engine restarts: ${supervisor.filter((e) => e.type === "exit").length}`);

out.push("", "## TURNS");
const turns = events.filter((e) => e.type === "turn");
if (!turns.length) out.push("(none)");
for (const t of turns) {
  const end = events.find((e) => e.type === "turn-end" && !e.followUp && e.agent === t.agent && e.sessionId === t.sessionId && e.seq > t.seq);
  const tools = end ? tally(end.tools ?? {}) : "";
  // The prompt as JSON: one line, quotes and newlines escaped, nothing that reads as a heading.
  out.push(`${t.at} ${t.agent} ${String(t.sessionId).slice(0, 8)} ${t.steer ? "steer" : "prompt"} ${JSON.stringify(t.prompt ?? "")} -> ${end ? `${end.outcome}; tools: ${tools}` : "no end recorded"}`);
}
console.log(out.join("\n"));
