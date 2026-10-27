#!/bin/sh
# A local dev container like the test harness's: the image, a stand-in LLM proxy (test/stub-gateway.mjs),
# a task config applied as the session user, and the supervisor. The shell page is on :3010.
#   sh scripts/dev-container.sh [task-config.json]       default: all three agents, terminal sandboxed
#   SANDBOX=1 sh scripts/dev-container.sh ...             allow user namespaces (seccomp unconfined) and a
#                                                         fresh /proc (systempaths unconfined), so the engines'
#                                                         sandboxes (bwrap) work as on the platform
#   BUILD=0 ...                                            reuse the image as it is
set -eu
cd "$(dirname "$0")/.."
IMAGE=cosmo-agents:dev
NAME=${NAME:-oc-dev}
PORT=${PORT:-3010}
CONFIG=${1:-}

[ "${BUILD:-1}" = 0 ] || docker build -q -f image/Dockerfile -t "$IMAGE" . >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT:3000" \
  ${SANDBOX:+--security-opt seccomp=unconfined --security-opt systempaths=unconfined} \
  -e OPENAI_BASE_URL=http://127.0.0.1:4000/v1 -e OPENAI_API_KEY=test-key-scoped \
  -e ANTHROPIC_BASE_URL=http://127.0.0.1:4000 -e ANTHROPIC_API_KEY=test-key-scoped \
  "$IMAGE" sleep infinity >/dev/null
docker cp test/stub-gateway.mjs "$NAME":/opt/stub-gateway.mjs >/dev/null
docker exec -d "$NAME" sh -c 'STUB_LOG=/tmp/stub.jsonl PORT=4000 node /opt/stub-gateway.mjs'
docker exec -u root "$NAME" sh -c 'env | grep -E "^(OPENAI|ANTHROPIC)_" | sed "s/^/export /" >> /home/runner/.profile'

if [ -n "$CONFIG" ]; then
  docker exec -i -u runner -w /usercode/FILESYSTEM "$NAME" sh -c 'mkdir -p .codesignal && cat > .codesignal/agent-sim.json' < "$CONFIG"
else
  docker exec -i -u runner -w /usercode/FILESYSTEM "$NAME" sh -c 'mkdir -p .codesignal && cat > .codesignal/agent-sim.json' <<'EOF'
{ "agents": ["cosmodex", "opencosmo", "cosmo-code"], "allowSwitch": true, "terminal": "sandboxed",
  "models": { "cosmodex": { "allowed": ["gpt-5.6-terra", "gpt-6-luna"] }, "opencosmo": { "allowed": ["anthropic/claude-sonnet-5-5"] },
              "cosmo-code": { "allowed": ["claude-sonnet-5-5"] } } }
EOF
fi
docker exec -u runner -w /usercode/FILESYSTEM "$NAME" sh -c '. ~/.profile; sudo -n /opt/agentsim/bin/apply-policy --config .codesignal/agent-sim.json && sudo -n /opt/agentsim/bin/agentsim-start' >/dev/null
echo "http://localhost:$PORT/"
