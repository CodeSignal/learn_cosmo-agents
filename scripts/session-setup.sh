#!/bin/sh
# Starts the simulation as the session user, for a platform image where setup has no root: the
# pinned engines the task uses are installed with npm into the simulation's own folder (whatever
# else the image has installed globally), then the engine host's dependencies and, when the
# system has none, bwrap for the agents' command sandboxes. Then the supervisor starts in user
# mode, and this returns once the server answers. The base task's setup.sh runs it from the unpacked release.
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

# bwrap without root: the distribution's package, unpacked (user namespaces do the rest).
if ! command -v bwrap >/dev/null 2>&1 && [ ! -x "$APP/vendor/bin/bwrap" ] && command -v apt-get >/dev/null 2>&1; then
  tmp=$(mktemp -d)
  if (cd "$tmp" && apt-get download bubblewrap >>"$LOG" 2>&1 && dpkg -x bubblewrap_*.deb x) && [ -x "$tmp/x/usr/bin/bwrap" ]; then
    mkdir -p "$APP/vendor/bin" && cp "$tmp/x/usr/bin/bwrap" "$APP/vendor/bin/bwrap"
    say "bwrap unpacked for the agents' sandboxes"
  else
    say "no bwrap: the agents' command sandboxes are unavailable"
  fi
  rm -rf "$tmp"
fi

node "$APP/root/supervisor.mjs" --user --config "$CONFIG" --state "$STATE" --daemon
for _ in $(seq 60); do
  if node -e 'fetch("http://127.0.0.1:3000/api/health").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'; then
    say "ready"
    exit 0
  fi
  sleep 1
done
say "the server did not start; the supervisor's log:"
tail -20 "$STATE/log/supervisor.log" "$STATE/log/server.log" 2>/dev/null
exit 1
