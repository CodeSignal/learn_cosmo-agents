#!/bin/sh
# BASE-TASK CONTENT: the base task's .codesignal/run_solution.sh (a read-only project file).
# Prints the simulation's report (README, "Evaluation output") from its records in the session
# user's home.
S="$HOME/.cosmo-agents"
if [ ! -f "$S/app/scripts/run_solution.sh" ]; then
  echo "The agent simulation is not installed in this session."
  exit 0
fi
AGENTSIM_STATE="$S/state" AGENTSIM_POLICY="$S/state/policy.json" exec sh "$S/app/scripts/run_solution.sh"
