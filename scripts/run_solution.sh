#!/bin/sh
# Prints what Cosmo evaluates: a summary and the turns (from the records the session user can't
# change), the task's agent setup, the simulation's event log (turns, switches, blocked attempts,
# tampering) and the agents' extracted transcripts, if the task's setup extracts them into
# <workspace>/.codesignal/<engine>/ (those live in the workspace, so they can be edited).
WORKSPACE="${WORKSPACE:-/usercode/FILESYSTEM}"
STATE="${AGENTSIM_STATE:-/var/lib/agentsim}"
POLICY="${AGENTSIM_POLICY:-/etc/agentsim/policy.json}"

node "$(dirname "$0")/summary.mjs" 2>/dev/null || echo "## SUMMARY
(summary unavailable)"

echo
echo "## AGENT SETUP"
cat "$POLICY" 2>/dev/null || echo "(no applied policy)"

echo
echo "## SIMULATION EVENTS"
cat "$STATE/events/events.jsonl" 2>/dev/null || echo "(none)"
echo
echo "## SUPERVISOR EVENTS"
cat "$STATE/supervisor.jsonl" 2>/dev/null || echo "(none)"

for engine in opencode codex claude; do
  dir="$WORKSPACE/.codesignal/$engine"
  [ -d "$dir" ] || continue
  echo
  echo "## TRANSCRIPT SUMMARY ($engine)"
  latest=$(ls "$dir"/interactions_summary.*.jsonl 2>/dev/null | sort -t. -k2 -n | tail -1)
  [ -n "$latest" ] && cat "$latest"
  echo
  echo "## TIMELINE ($engine)"
  n=$(basename "$latest" | sed -E 's/interactions_summary\.([0-9]+)\.jsonl/\1/')
  ls "$dir"/timeline."$n".part*.txt 2>/dev/null | sort -V | xargs cat 2>/dev/null
done
