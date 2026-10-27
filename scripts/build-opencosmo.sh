#!/bin/sh
# Builds OpenCosmo (the vendored OpenCode web app) into dist-agents/opencosmo with Bun in
# Docker, served by the simulation under /agents/opencosmo/ and talking to /engine/opencosmo.
#   UPDATE_LOCK=1 sh scripts/build-opencosmo.sh   re-resolve and write vendor/opencode/bun.lock
set -eu
cd "$(dirname "$0")/.."
BUN_IMAGE=oven/bun:1.3.14
mkdir -p dist-agents
docker run --rm \
  -e UPDATE_LOCK="${UPDATE_LOCK:-}" \
  -v "$PWD/vendor/opencode:/src" \
  -v "$PWD/dist-agents:/out" \
  -v cosmo-agents-bun-cache:/root/.bun/install/cache \
  "$BUN_IMAGE" sh -euc '
    mkdir -p /work && cd /src && tar --exclude=./node_modules --exclude="./packages/*/node_modules" -cf - . | tar -C /work -xf -
    cd /work
    if [ -n "$UPDATE_LOCK" ]; then
      bun install --filter "@opencode-ai/app"
      cp bun.lock /src/bun.lock
    else
      bun install --filter "@opencode-ai/app" --frozen-lockfile
    fi
    cd packages/app
    OPENCOSMO_BASE=/agents/opencosmo/ VITE_ENGINE_PATH=/engine/opencosmo VITE_WORKSPACE=/usercode/FILESYSTEM OPENCODE_CHANNEL=prod bun run build
    rm -rf /out/opencosmo && cp -a dist /out/opencosmo
  '
du -sh dist-agents/opencosmo
