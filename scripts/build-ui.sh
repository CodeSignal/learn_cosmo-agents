#!/bin/sh
# Builds the agent UIs into dist-agents/<agent> with Bun in Docker. The vendored OpenCode
# workspace (vendor/opencode) provides the UI kit; our apps (apps/*) are composed into it as
# packages/<app> for the build only, so upstream code and ours stay in separate trees.
#   sh scripts/build-ui.sh [opencosmo] [cosmodex] [cosmo-code]     default: all
#   UPDATE_LOCK=1 sh scripts/build-ui.sh              re-resolve and write vendor/opencode/bun.lock
set -eu
cd "$(dirname "$0")/.."
BUN_IMAGE=oven/bun:1.3.14
AGENTS="${*:-opencosmo cosmodex cosmo-code}"
mkdir -p dist-agents
docker run --rm \
  -e UPDATE_LOCK="${UPDATE_LOCK:-}" -e AGENTS="$AGENTS" \
  -v "$PWD/vendor/opencode:/src" \
  -v "$PWD/apps:/apps:ro" \
  -v "$PWD/dist-agents:/out" \
  -v cosmo-agents-bun-cache:/root/.bun/install/cache \
  "$BUN_IMAGE" sh -euc '
    mkdir -p /work && cd /src && tar --exclude=./node_modules --exclude="./packages/*/node_modules" -cf - . | tar -C /work -xf -
    for app in /apps/*; do cp -R "$app" "/work/packages/$(basename "$app")"; done
    cd /work
    FILTERS="--filter @opencode-ai/app --filter @cosmo/cosmodex --filter @cosmo/cosmo-code"
    if [ -n "$UPDATE_LOCK" ]; then
      bun install $FILTERS
      cp bun.lock /src/bun.lock
    else
      bun install $FILTERS --frozen-lockfile
    fi
    for agent in $AGENTS; do
      case "$agent" in
        opencosmo) dir=packages/app
          (cd $dir && OPENCOSMO_BASE=/_cosmo/agents/opencosmo/ VITE_ENGINE_PATH=/_cosmo/engine/opencosmo VITE_COSMO=/_cosmo VITE_WORKSPACE=/usercode/FILESYSTEM OPENCODE_CHANNEL=prod bun run build) ;;
        cosmodex) dir=packages/cosmodex
          (cd $dir && COSMODEX_BASE=/_cosmo/agents/cosmodex/ VITE_ENGINE_PATH=/_cosmo/engine/cosmodex VITE_COSMO=/_cosmo VITE_WORKSPACE=/usercode/FILESYSTEM bun run build) ;;
        cosmo-code) dir=packages/cosmo-code
          (cd $dir && COSMO_CODE_BASE=/_cosmo/agents/cosmo-code/ VITE_ENGINE_PATH=/_cosmo/engine/cosmo-code VITE_COSMO=/_cosmo VITE_WORKSPACE=/usercode/FILESYSTEM bun run build) ;;
        *) echo "unknown agent $agent" >&2; exit 64 ;;
      esac
      rm -rf "/out/$agent" && cp -a "$dir/dist" "/out/$agent"
    done
  '
du -sh dist-agents/*
