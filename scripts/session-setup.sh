#!/bin/sh
# Starts the simulation as the session user, for a platform image where setup has no root: the
# pinned engines the task uses are installed with npm into the simulation's own folder (whatever
# else the image has installed globally), then the engine host's dependencies. Then the supervisor
# starts in user mode (each engine in its own sandbox, with the bwrap the release carries), and
# this returns once the server answers. The base task's setup.sh runs it from the unpacked release.
#   sh scripts/session-setup.sh <agent-sim.json>
set -eu
APP=$(cd "$(dirname "$0")/.." && pwd)
CONFIG=${1:?usage: session-setup.sh <agent-sim.json>}
STATE=${AGENTSIM_HOME:-$HOME/.cosmo-agents}
mkdir -p "$STATE/log"
LOG="$STATE/log/setup.log"
ENGINES="$STATE/engines"
export PATH="$ENGINES/bin:$PATH"
say() { echo "agentsim: $*"; }

# The engines the task's agents need, as "package@version bin" lines.
engines=$(node -e '
  const [pins, config] = process.argv.slice(1).map((f) => JSON.parse(require("fs").readFileSync(f, "utf8")));
  const used = new Set((config.agents ?? []).map((a) => pins.agents[a]).filter(Boolean));
  for (const id of used) { const e = pins.engines[id]; console.log(`${e.package}@${e.version} ${e.bin} ${e.version}`); }
' "$APP/policy/pins.json" "$CONFIG")

echo "$engines" | while read -r spec bin version; do
  [ -n "$spec" ] || continue
  if "$ENGINES/bin/$bin" --version 2>/dev/null | grep -qF "$version"; then
    say "$spec already installed"
  else
    say "installing $spec"
    npm install -g --prefix "$ENGINES" --no-fund --no-audit "$spec" >>"$LOG" 2>&1 || { say "npm install $spec failed; see $LOG"; exit 1; }
  fi
done

if echo "$engines" | grep -q '@anthropic-ai/claude-code' && [ ! -d "$APP/engines/claude-host/node_modules" ]; then
  say "installing the Cosmo Code engine host's dependencies"
  (cd "$APP/engines/claude-host" && npm ci --omit=optional --no-fund --no-audit >>"$LOG" 2>&1) || { say "npm ci failed; see $LOG"; exit 1; }
fi

# The workspace folder belongs to root on the platform, so git refuses it for the session user
# (the changes view, file search, the engines' project detection) unless it is marked safe.
WORKSPACE=/usercode/FILESYSTEM
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$WORKSPACE" || git config --global --add safe.directory "$WORKSPACE"

node "$APP/root/supervisor.mjs" --user --config "$CONFIG" --state "$STATE" --daemon
for _ in $(seq 60); do
  if node -e 'fetch("http://127.0.0.1:3000/_cosmo/api/health").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'; then
    say "ready"
    exit 0
  fi
  sleep 1
done
say "the server did not start; the supervisor's log:"
tail -20 "$STATE/log/supervisor.log" "$STATE/log/server.log" 2>/dev/null
exit 1
