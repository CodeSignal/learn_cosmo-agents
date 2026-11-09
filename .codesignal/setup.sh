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
API="https://api.github.com/repos/CodeSignal/learn_cosmo-agents/releases/latest"
if [ "${APP_ENVIRONMENT:-}" = "staging" ]; then
  URL="https://github.com/CodeSignal/learn_cosmo-agents/releases/download/prerelease/release.tar.gz"
  API="https://api.github.com/repos/CodeSignal/learn_cosmo-agents/releases/tags/prerelease"
fi

rm -rf "$APP" && mkdir -p "$APP"
# GitHub's release download links can fail for anonymous clients while its API still serves the file.
TARBALL="$HOME/.cosmo-agents/release.tar.gz"
if ! curl -fsSL --retry 3 -o "$TARBALL" "$URL"; then
  ASSET="$(curl -fsSL --retry 3 "$API" | grep -o '"url": *"https://api.github.com/[^"]*/releases/assets/[0-9]*"' | head -1 | cut -d'"' -f4)"
  [ -n "$ASSET" ] || { echo "setup: no release asset found at $API" >&2; exit 1; }
  curl -fsSL --retry 3 -H "Accept: application/octet-stream" -o "$TARBALL" "$ASSET"
fi
tar -xzf "$TARBALL" -C "$APP"
rm -f "$TARBALL"
sh "$APP/scripts/session-setup.sh" /usercode/FILESYSTEM/.codesignal/agent-sim.json
