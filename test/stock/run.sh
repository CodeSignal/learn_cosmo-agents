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
# The platform allows user namespaces (Docker's default seccomp profile and, where the host has
# it, AppArmor don't) but, like Docker's masked /proc paths, no fresh /proc in one.
docker run -d --name "$NAME" -p "$PORT:3000" \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  -e OPENAI_BASE_URL=http://127.0.0.1:4000/v1 -e OPENAI_API_KEY=test-key-scoped \
  -e ANTHROPIC_BASE_URL=http://127.0.0.1:4000 -e ANTHROPIC_API_KEY=test-key-scoped \
  -e APP_ENVIRONMENT=staging cosmo-agents:stock sleep infinity >/dev/null
docker cp test/stub-gateway.mjs "$NAME":/tmp/stub-gateway.mjs >/dev/null
docker cp "$TARBALL" "$NAME":/tmp/release.tar.gz >/dev/null
for f in test/container/cosmodex-check.mjs test/container/cosmo-code-check.mjs test/stock/view-check.mjs; do docker cp "$f" "$NAME":/tmp/ >/dev/null; done
docker exec -d "$NAME" sh -c 'STUB_FIND=WORKING-AGREEMENT-7731 STUB_LOG=/tmp/stub.jsonl PORT=4000 node /tmp/stub-gateway.mjs'
# The task's files, read-only and root's, as the platform delivers them.
docker exec -i -u root "$NAME" sh -c 'cat > .codesignal/agent-sim.json && echo "bash .codesignal/run_solution.sh" > main.sh && chmod 0444 .codesignal/agent-sim.json main.sh' <<'JSON'
{ "agents": ["cosmo-code", "cosmodex", "opencosmo"], "allowSwitch": true,
  "instructions": "WORKING-AGREEMENT-7731: stay in the workspace.",
  "models": { "opencosmo": { "allowed": ["anthropic/claude-sonnet-5-5"], "names": true, "efforts": ["low", "medium", "high"] },
              "cosmodex": { "allowed": ["gpt-5.6-terra", "gpt-6-luna"], "names": true, "efforts": ["low", "medium"] },
              "cosmo-code": { "allowed": ["claude-sonnet-5-5"], "names": true, "efforts": ["low", "medium", "high"] } },
  "app": { "port": 5173 } }
JSON

# What the base task's setup.sh does, with the release from a local file instead of a download.
echo "-- setup"
start=$(date +%s)
docker exec "$NAME" sh -c 'APP=$HOME/.cosmo-agents/app && mkdir -p $APP && tar -xzf /tmp/release.tar.gz -C $APP && sh $APP/scripts/session-setup.sh /usercode/FILESYSTEM/.codesignal/agent-sim.json' \
  || { echo "FAIL setup"; exit 1; }
echo "setup took $(( $(date +%s) - start ))s"
docker exec "$NAME" sh -c 'grep "\"sandbox\"" ~/.cosmo-agents/state/supervisor.jsonl | tail -1'

echo "-- checks"
docker exec "$NAME" node /tmp/cosmodex-check.mjs
docker exec "$NAME" node /tmp/cosmo-code-check.mjs
docker exec "$NAME" node /tmp/view-check.mjs
# The task's instructions reach every agent's model requests.
docker exec "$NAME" sh -c 'for p in /v1/messages /v1/responses; do if grep "\"url\":\"$p" /tmp/stub.jsonl | grep -q "\"found\":true"; then echo "PASS  I$p the task instructions reach the model"; else echo "FAIL  I$p the task instructions never reached the model"; fi; done'
# The transcript record for grading, in the provisioner's format (server/transcript.mjs).
docker exec "$NAME" sh -c 'sleep 3; for e in claude codex; do f=$(ls /usercode/FILESYSTEM/.codesignal/$e/interactions_summary.*.jsonl 2>/dev/null | head -1); t=$(ls /usercode/FILESYSTEM/.codesignal/$e/timeline.*.part1.txt 2>/dev/null | head -1); if [ -n "$f" ] && [ -n "$t" ] && grep -q "\"kind\": *\"session\"" "$f" && grep -q "\"input_text\"" "$f" && grep -q "USER:" "$t"; then echo "PASS  L-$e the transcript record has sessions, prompts and a timeline"; else echo "FAIL  L-$e no transcript record in .codesignal/$e"; fi; done'
# The task's own web app (app.port 5173): every path outside the simulation's own reaches it.
docker exec -d -u runner "$NAME" node -e 'require("http").createServer((q, s) => s.end("APP " + q.url)).listen(5173)'
docker exec "$NAME" sh -c 'sleep 1; a=$(curl -s localhost:3000/app/x); d=$(curl -s localhost:3000/data/lots.json); h=$(curl -s -o /dev/null -w %{http_code} localhost:3000/_cosmo/api/health); r=$(curl -s localhost:3000/ | grep -c "/_cosmo/assets/"); if [ "$a" = "APP /app/x" ] && [ "$d" = "APP /app/data/lots.json" ] && [ "$h" = 200 ] && [ "$r" -ge 1 ]; then echo "PASS  A1   a task app gets every path outside the simulation'"'"'s own"; else echo "FAIL  A1   task app routing: $a | $d | $h | $r"; fi' || echo "FAIL  A1   the routing check could not run"
# Once the task's setup is done, the workspace is committed as the starting point (changes are the candidate's).
docker exec -u runner "$NAME" sh -c 'touch /tmp/.setup_finished; sleep 2; cd /usercode/FILESYSTEM; if [ "$(git log -1 --format=%s)" = "Starting point" ] && [ -z "$(git status --porcelain)" ] && [ "$(git ls-files .codesignal main.sh node_modules dist | wc -l)" -eq 0 ] && echo w1 >> w1-probe.txt && git status --porcelain | grep -q w1-probe.txt; then echo "PASS  W1   setup'"'"'s end commits the workspace as the starting point; later edits are changes"; else echo "FAIL  W1   starting point: $(git log -1 --format=%s 2>&1), $(git status --porcelain | wc -l) changes, $(git ls-files .codesignal main.sh | wc -l) excluded files tracked"; fi' || echo "FAIL  W1   the starting-point check could not run"
echo "http://localhost:$PORT/"
