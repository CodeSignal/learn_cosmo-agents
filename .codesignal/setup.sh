#!/bin/sh
# BASE-TASK CONTENT: the base task's .codesignal/setup.sh (a read-only project file). See
# .codesignal/README.md.
#
# Installs the simulation in the session user's home, outside the workspace (the editor shows
# only the task's files), and starts it for the task's .codesignal/agent-sim.json. It returns
# once the server on :3000 answers; the simulation keeps running in the background.
set -eu
APP="$HOME/.cosmo-agents/app"

# Production runs the latest release; staging the newest build (README, "Releases").
URL="https://github.com/CodeSignal/learn_cosmo-agents/releases/latest/download/release.tar.gz"
if [ "${APP_ENVIRONMENT:-}" = "staging" ]; then
  URL="https://github.com/CodeSignal/learn_cosmo-agents/releases/download/prerelease/release.tar.gz"
fi

rm -rf "$APP" && mkdir -p "$APP"
curl -fsSL --retry 3 "$URL" | tar -xz -C "$APP"
sh "$APP/scripts/session-setup.sh" /usercode/FILESYSTEM/.codesignal/agent-sim.json
