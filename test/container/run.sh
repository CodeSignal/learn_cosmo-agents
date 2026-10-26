#!/bin/sh
# Container red-team checks for the foundation: builds the image, applies a policy as the
# session user through sudo, starts the supervisor, then tries to get around each layer.
# Needs Docker. Usage: sh test/container/run.sh [--keep]
set -u
cd "$(dirname "$0")/../.."
IMAGE=cosmo-agents:dev
NAME=cosmo-agents-check
KEEP=${1:-}
FAILS=0

check() { # check <id> <description> <command...>: passes when the command succeeds
  id=$1; desc=$2; shift 2
  if out=$("$@" 2>&1); then printf 'PASS  %-4s %s\n' "$id" "$desc"
  else printf 'FAIL  %-4s %s\n%s\n' "$id" "$desc" "$(echo "$out" | tail -5 | sed 's/^/      /')"; FAILS=$((FAILS + 1)); fi
}
as_runner() { docker exec -u runner -w /usercode/FILESYSTEM "$NAME" sh -c "$1"; }
as_root() { docker exec -u root "$NAME" sh -c "$1"; }

echo "building $IMAGE"
docker build -q -f image/Dockerfile -t "$IMAGE" . >/dev/null || { echo "image build failed"; exit 1; }
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" \
  -e OPENAI_BASE_URL=http://127.0.0.1:4000/v1 -e OPENAI_API_KEY=test-key-scoped \
  -e ANTHROPIC_BASE_URL=http://127.0.0.1:4000 -e ANTHROPIC_API_KEY=test-key-scoped \
  "$IMAGE" sleep infinity >/dev/null
# The platform's session user gets the proxy variables in its environment.
as_root 'env | grep -E "^(OPENAI|ANTHROPIC)_" | sed "s/^/export /" >> /home/runner/.profile'
R() { as_runner ". ~/.profile; $1"; }

docker exec -i -u runner -w /usercode/FILESYSTEM "$NAME" sh -c 'mkdir -p .codesignal && cat > .codesignal/agent-sim.json' <<'EOF'
{ "agents": ["opencosmo", "cosmodex", "cosmo-code"], "default": "opencosmo",
  "models": { "opencosmo": { "allowed": ["anthropic/claude-sonnet-5-5"] },
              "cosmodex": { "allowed": ["gpt-5.6-terra"] },
              "cosmo-code": { "allowed": ["claude-sonnet-5-5"] } } }
EOF

echo
echo "-- policy"
check S1 "sudo offers the session user exactly the two helpers" \
  sh -c "[ \"\$(docker exec -u runner $NAME sudo -n -l | grep -o '/opt/agentsim/bin/[a-z-]*' | sort -u | tr '\\n' ' ')\" = '/opt/agentsim/bin/agentsim-start /opt/agentsim/bin/apply-policy ' ] && [ \"\$(docker exec -u runner $NAME sudo -n -l | grep -c NOPASSWD)\" = 1 ]"
check S2 "apply-policy succeeds as the session user via sudo" \
  R 'sudo -n /opt/agentsim/bin/apply-policy --config .codesignal/agent-sim.json'
check S3 "policy files are root-owned 0644" \
  as_root 'for f in /etc/agentsim/policy.json /etc/opencode/opencode.json /etc/codex/requirements.toml /etc/codex/models.json /etc/claude-code/managed-settings.json; do [ "$(stat -c %U:%a $f)" = root:644 ] || { echo "$f $(stat -c %U:%a $f)"; exit 1; }; done'
check S4 "the Codex catalog was read from the installed CLI and narrowed" \
  as_root '[ "$(jq -r "[.models[].slug]|join(\",\")" /etc/codex/models.json)" = gpt-5.6-terra ]'
check S5 "a second apply is refused" \
  sh -c "! docker exec -u runner -w /usercode/FILESYSTEM $NAME sudo -n /opt/agentsim/bin/apply-policy --config .codesignal/agent-sim.json"
check R10 "the session user cannot change any policy file" \
  as_runner 'for f in /etc/agentsim/policy.json /etc/opencode/opencode.json /etc/codex/requirements.toml /etc/claude-code/managed-settings.json; do if echo x >> $f 2>/dev/null; then echo "wrote $f"; exit 1; fi; done; ! mv /etc/codex/requirements.toml /tmp/ 2>/dev/null'
check S6 "sudo refuses to pass NODE_OPTIONS through" \
  sh -c "docker exec -u runner $NAME sh -c 'echo \"require(\\\"fs\\\").writeFileSync(\\\"/tmp/pwned\\\",\\\"x\\\")\" > /tmp/evil.cjs; NODE_OPTIONS=--require=/tmp/evil.cjs sudo -n -E /opt/agentsim/bin/apply-policy --config x' ; ! docker exec $NAME test -e /tmp/pwned"
check S7 "test-only redirections are refused under sudo" \
  sh -c "docker exec -u runner $NAME sudo -n /opt/agentsim/bin/apply-policy --root /tmp/x --config /dev/null; [ \$? = 64 ]"
check S8 "the helper code is not writable by the session user" \
  as_runner '! touch /opt/agentsim/root/apply-policy.mjs 2>/dev/null && ! touch /opt/agentsim/bin/apply-policy 2>/dev/null'

echo
echo "-- supervisor and server"
check S9 "supervisor starts as root via sudo" \
  R 'sudo -n /opt/agentsim/bin/agentsim-start'
sleep 2
check S10 "server answers on :3000 with the task's agents" \
  as_runner 'curl -sf localhost:3000/api/session | grep -q "\"active\":\"opencosmo\""'
check S11 "the shell page is served" \
  as_runner 'curl -sf localhost:3000/ | grep -q "Cosmo Agents"'
check S12 "server runs as agentsim, supervisor as root" \
  as_root '[ "$(ps -o user= -p $(pgrep -f server/index.mjs | head -1))" = agentsim ] && [ "$(ps -o user= -p $(cat /run/agentsim/supervisor.pid))" = root ]'
check R11a "the session user cannot kill the server" \
  as_runner '! kill $(pgrep -f server/index.mjs | head -1) 2>/dev/null'
check R11b "the session user cannot take port 3000 while the server is up" \
  as_runner '! timeout 2 python3 -m http.server 3000 >/dev/null 2>&1; [ $? -ne 124 ]'
check R11c "a killed server is restarted" \
  sh -c "old=\$(docker exec $NAME pgrep -f server/index.mjs | head -1); docker exec $NAME kill \$old; sleep 3; new=\$(docker exec $NAME pgrep -f server/index.mjs | head -1); [ -n \"\$new\" ] && [ \"\$new\" != \"\$old\" ]"
check R11d "an impostor on :3000 is killed and the server comes back" \
  sh -c "docker exec $NAME pkill -f server/index.mjs; docker exec -d -u runner $NAME python3 -m http.server 3000; sleep 8; docker exec -u runner $NAME curl -sf localhost:3000/api/session >/dev/null && docker exec $NAME grep -q '\"type\":\"tamper\"' /var/lib/agentsim/supervisor.jsonl"
check S13 "switching is refused (task disallows it) and logged" \
  sh -c "docker exec -u runner $NAME curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/api/switch -d '{\"agent\":\"cosmodex\"}' | grep -q 403 && docker exec $NAME grep -q '\"reason\":\"switching disabled\"' /var/lib/agentsim/events/events.jsonl"
check S14 "the session user cannot rewrite the event log" \
  as_runner '! echo x >> /var/lib/agentsim/events/events.jsonl 2>/dev/null && ! echo x >> /var/lib/agentsim/supervisor.jsonl 2>/dev/null'
check S15 "run_solution prints setup, events and supervisor log" \
  as_runner '/opt/agentsim/scripts/run_solution.sh | grep -q "## SIMULATION EVENTS" && /opt/agentsim/scripts/run_solution.sh | grep -q tamper'

echo
if [ "$FAILS" -eq 0 ]; then echo "all checks passed"; else echo "$FAILS check(s) failed"; fi
[ "$KEEP" = "--keep" ] || docker rm -f "$NAME" >/dev/null
exit $((FAILS > 0))
