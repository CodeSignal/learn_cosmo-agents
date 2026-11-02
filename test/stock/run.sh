#!/bin/sh
# The simulation on a stand-in for the platform's standard image (test/stock/Dockerfile): no root
# at setup, so it runs in user mode. Installs a release tarball the way the base task's setup.sh
# does, with a stand-in LLM proxy, then runs the gateway checks against it. The UI is on :3020
# afterwards for `npm run test:ui -- --base http://localhost:3020`.
#   sh test/stock/run.sh [release.tar.gz]     default: builds one with the image's release stage
set -u
cd "$(dirname "$0")/../.."
NAME=${NAME:-cosmo-agents-stock}
PORT=${PORT:-3020}
TARBALL=${1:-}
if [ -z "$TARBALL" ]; then
  docker build -q -f image/Dockerfile --target release -o out . >/dev/null || { echo "release build failed"; exit 1; }
  TARBALL=out/release.tar.gz
fi
docker build -q -t cosmo-agents:stock test/stock >/dev/null || { echo "stock image build failed"; exit 1; }
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p "$PORT:3000" \
  -e OPENAI_BASE_URL=http://127.0.0.1:4000/v1 -e OPENAI_API_KEY=test-key-scoped \
  -e ANTHROPIC_BASE_URL=http://127.0.0.1:4000 -e ANTHROPIC_API_KEY=test-key-scoped \
  -e APP_ENVIRONMENT=staging cosmo-agents:stock sleep infinity >/dev/null
docker cp test/stub-gateway.mjs "$NAME":/tmp/stub-gateway.mjs >/dev/null
docker cp "$TARBALL" "$NAME":/tmp/release.tar.gz >/dev/null
for f in test/container/cosmodex-check.mjs test/container/cosmo-code-check.mjs; do docker cp "$f" "$NAME":/tmp/ >/dev/null; done
docker exec -d "$NAME" sh -c 'STUB_LOG=/tmp/stub.jsonl PORT=4000 node /tmp/stub-gateway.mjs'
docker exec -i "$NAME" sh -c 'cat > .codesignal/agent-sim.json' <<'JSON'
{ "agents": ["cosmo-code", "cosmodex", "opencosmo"], "allowSwitch": true,
  "models": { "opencosmo": { "allowed": ["anthropic/claude-sonnet-5-5"] },
              "cosmodex": { "allowed": ["gpt-5.6-terra", "gpt-6-luna"] },
              "cosmo-code": { "allowed": ["claude-sonnet-5-5"] } } }
JSON

# What the base task's setup.sh does, with the release from a local file instead of a download.
echo "-- setup"
start=$(date +%s)
docker exec "$NAME" sh -c 'APP=$HOME/.cosmo-agents/app && mkdir -p $APP && tar -xzf /tmp/release.tar.gz -C $APP && sh $APP/scripts/session-setup.sh /usercode/FILESYSTEM/.codesignal/agent-sim.json' \
  || { echo "FAIL setup"; exit 1; }
echo "setup took $(( $(date +%s) - start ))s"

echo "-- checks"
docker exec "$NAME" node /tmp/cosmodex-check.mjs
docker exec "$NAME" node /tmp/cosmo-code-check.mjs
echo "http://localhost:$PORT/"
