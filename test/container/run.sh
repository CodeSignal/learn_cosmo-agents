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
# A stand-in for the LLM proxy, inside the container (keys: test-key-scoped allows Sonnet,
# Haiku, Terra and Luna; the task narrows further).
docker cp test/stub-gateway.mjs "$NAME":/opt/stub-gateway.mjs >/dev/null
docker cp test/container/cosmodex-check.mjs "$NAME":/opt/cosmodex-check.mjs >/dev/null
docker cp test/container/cosmo-code-check.mjs "$NAME":/opt/cosmo-code-check.mjs >/dev/null
docker exec -d "$NAME" sh -c 'STUB_LOG=/tmp/stub.jsonl PORT=4000 node /opt/stub-gateway.mjs'
# The platform's session user gets the proxy variables in its environment.
as_root 'env | grep -E "^(OPENAI|ANTHROPIC)_" | sed "s/^/export /" >> /home/runner/.profile'
R() { as_runner ". ~/.profile; $1"; }

docker exec -i -u runner -w /usercode/FILESYSTEM "$NAME" sh -c 'mkdir -p .codesignal && cat > .codesignal/agent-sim.json' <<'EOF'
{ "agents": ["opencosmo", "cosmodex", "cosmo-code"], "default": "opencosmo",
  "models": { "opencosmo": { "allowed": ["anthropic/claude-sonnet-5-5"] },
              "cosmodex": { "allowed": ["gpt-5.6-terra", "gpt-6-luna"] },
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
  as_root '[ "$(jq -r "[.models[].slug]|join(\",\")" /etc/codex/models.json)" = gpt-5.6-terra,gpt-6-luna ]'
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
echo "-- OpenCosmo (OpenCode engine)"
G=localhost:3000/engine/opencosmo
D='directory=%2Fusercode%2FFILESYSTEM'
sleep 2
check O1 "opencode serve runs as the session user on loopback only" \
  as_root '[ "$(ps -o user= -p $(pgrep -f "opencode serve" | head -1))" = runner ] && grep -q "0100007F:1000 00000000:0000 0A" /proc/net/tcp && ! grep -qE "00000000:1000 00000000:0000 0A" /proc/net/tcp'
check O2 "the OpenCosmo UI is served" \
  as_runner 'curl -sf localhost:3000/agents/opencosmo/ | grep -q "<div id=\"root\""'
check O3 "the engine refuses requests without the gateway's password" \
  as_runner '[ "$(curl -s -o /dev/null -w %{http_code} 127.0.0.1:4096/global/health)" = 401 ] && curl -sf '$G'/global/health | grep -q "\"healthy\":true"'
# Send a prompt without waiting for the turn (it may stop at a permission prompt).
prompt() { # prompt <text> -> prints the session id
  docker exec -u runner $NAME sh -c "sid=\$(curl -sf -X POST '$G/session?$D' -H content-type:application/json -d {} | jq -r .id) && curl -sf -X POST \"$G/session/\$sid/prompt_async?$D\" -H content-type:application/json -d '{\"parts\":[{\"type\":\"text\",\"text\":\"$1\"}],\"model\":{\"providerID\":\"anthropic\",\"modelID\":\"claude-sonnet-5-5\"}}' >/dev/null && echo \$sid"
}
pending() { # pending <session id> -> prints the id of its pending permission request, waiting up to 15 s
  docker exec -u runner $NAME sh -c "for i in \$(seq 30); do p=\$(curl -sf '$G/permission?$D' | jq -r '[.[] | select(.sessionID==\"$1\")][0].id // empty'); [ -n \"\$p\" ] && echo \$p && exit 0; sleep 0.5; done; exit 1"
}
reply() { # reply <permission id> <once|always|reject>
  docker exec -u runner $NAME curl -sf -X POST "$G/permission/$1/reply?$D" -H content-type:application/json -d "{\"reply\":\"$2\"}" >/dev/null
}
p1() { sid=$(prompt "RUN: echo approved > approved.txt") && p=$(pending "$sid") && ! docker exec $NAME test -e /usercode/FILESYSTEM/approved.txt && reply "$p" once && sleep 2 && docker exec $NAME grep -q approved /usercode/FILESYSTEM/approved.txt; }
p2() { sid=$(prompt "RUN: echo rejected > rejected.txt") && p=$(pending "$sid") && reply "$p" reject && sleep 2 && ! docker exec $NAME test -e /usercode/FILESYSTEM/rejected.txt; }
check P1 "by default a shell command waits for the candidate's approval, then runs" p1
check P2 "a rejected command does not run" p2
check P3 "both answers are in the event log" \
  as_root '[ "$(grep -c "\"type\":\"permission-reply\"" /var/lib/agentsim/events/events.jsonl)" -ge 2 ] && grep -q "\"reply\":\"reject\"" /var/lib/agentsim/events/events.jsonl'
check R1 "a model the key allows but the task doesn't is refused by the engine (never reaches the proxy)" \
  sh -c "docker exec -u runner $NAME sh -c 'sid=\$(curl -sf -X POST \"$G/session?$D\" -H content-type:application/json -d {} | jq -r .id); curl -s -X POST \"$G/session/\$sid/message?$D\" -H content-type:application/json -d \"{\\\"parts\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"hi\\\"}],\\\"model\\\":{\\\"providerID\\\":\\\"anthropic\\\",\\\"modelID\\\":\\\"claude-haiku-5-5\\\"}}\"' >/dev/null; sleep 1; ! docker exec $NAME grep -q claude-haiku-5-5 /tmp/stub.jsonl"
check O5 "configuration, credentials, MCP, sharing and deleting sessions are refused and logged" \
  as_runner 'for r in "PATCH /config" "PUT /auth/anthropic" "POST /mcp" "POST /session/x/share" "DELETE /session/x" "POST /pty"; do set -- $r; [ "$(curl -s -o /dev/null -w %{http_code} -X $1 '$G'$2 -d "{}")" = 403 ] || { echo "$r not refused"; exit 1; }; done; [ "$(grep -c "\"gateway\":\"opencode\"" /var/lib/agentsim/events/events.jsonl)" -ge 6 ]'
check O6 "folders outside the workspace are refused" \
  as_runner '[ "$(curl -s -o /dev/null -w %{http_code} "'$G'/file?directory=%2Fetc")" = 403 ]'
check O7 "the task's .codesignal folder is git-excluded and absent from the engine's file search" \
  as_runner 'git -C /usercode/FILESYSTEM check-ignore -q .codesignal/agent-sim.json && [ "$(curl -sf "'$G'/find/file?query=agent-sim&'$D'")" = "[]" ]'
check R6 "MCP servers and permissions from user or project config are not loaded, even after a restart" \
  as_runner 'mkdir -p ~/.config/opencode && echo "{\"mcp\":{\"evil\":{\"type\":\"local\",\"command\":[\"sh\"]}},\"permission\":{\"webfetch\":\"allow\"}}" > ~/.config/opencode/opencode.json && cp ~/.config/opencode/opencode.json /usercode/FILESYSTEM/opencode.json && pkill -f "[o]pencode serve"; sleep 3; for i in $(seq 15); do c=$(curl -sf "'$G'/config?'$D'") && break; sleep 1; done; echo "$c" | jq -e ".mcp == {} and .permission.webfetch == \"deny\"" >/dev/null'
check R11e "a killed engine is restarted by the supervisor" \
  sh -c "old=\$(docker exec $NAME pgrep -f 'opencode serve' | head -1); docker exec -u runner $NAME kill \$old; sleep 4; new=\$(docker exec $NAME pgrep -f 'opencode serve' | head -1); [ -n \"\$new\" ] && [ \"\$new\" != \"\$old\" ]"
check R11f "an engine port the agent grabs is taken back, and the engine returns locked" \
  sh -c "docker exec -u runner $NAME pkill -f 'opencode serve'; docker exec -d -u runner $NAME python3 -m http.server --bind 127.0.0.1 4096; sleep 10; docker exec $NAME grep -q '\"type\":\"tamper\",\"service\":\"opencode\"' /var/lib/agentsim/supervisor.jsonl && [ \"\$(docker exec -u runner $NAME curl -s -o /dev/null -w %{http_code} 127.0.0.1:4096/global/health)\" = 401 ]"
echo
echo "-- Cosmodex (Codex engine)"
check X0 "codex app-server runs as the session user on loopback only" \
  as_root '[ "$(ps -o user= -p $(pgrep -f "codex app-server" | head -1))" = runner ] && grep -q "0100007F:1194 00000000:0000 0A" /proc/net/tcp && ! grep -q "00000000:1194 00000000:0000 0A" /proc/net/tcp'
check X10 "the Cosmodex UI is served and reported available" \
  as_runner 'curl -sf localhost:3000/agents/cosmodex/ | grep -q "<title>Cosmodex</title>" && curl -sf localhost:3000/api/session | jq -e ".agents[] | select(.id==\"cosmodex\") | .available" >/dev/null'
out=$(docker exec -u runner "$NAME" node /opt/cosmodex-check.mjs 2>&1); echo "$out"
FAILS=$((FAILS + $(echo "$out" | grep -c '^FAIL')))
check X9 "Cosmodex refusals and approval answers are in the event log" \
  as_root 'grep -q "\"gateway\":\"codex\".*\"reason\":\"configuration\"" /var/lib/agentsim/events/events.jsonl && grep -q "\"gateway\":\"codex\".*\"reply\":\"accept\"" /var/lib/agentsim/events/events.jsonl'

echo
echo "-- Cosmo Code (Claude engine through the Agent SDK)"
check C0 "the engine host runs as the session user on loopback only" \
  as_root '[ "$(ps -o user= -p $(pgrep -f "claude-host/host.mjs" | head -1))" = runner ] && grep -q "0100007F:11F8 00000000:0000 0A" /proc/net/tcp && ! grep -q "00000000:11F8 00000000:0000 0A" /proc/net/tcp'
check C10 "the Cosmo Code UI is served and reported available" \
  as_runner 'curl -sf localhost:3000/agents/cosmo-code/ | grep -q "<title>Cosmo Code</title>" && curl -sf localhost:3000/api/session | jq -e ".agents[] | select(.id==\"cosmo-code\") | .available" >/dev/null'
out=$(docker exec -u runner "$NAME" node /opt/cosmo-code-check.mjs 2>&1); echo "$out"
FAILS=$((FAILS + $(echo "$out" | grep -c '^FAIL')))
check C9 "Cosmo Code refusals and approval answers are in the event log" \
  as_root 'grep -q "\"gateway\":\"claude\".*\"reason\":\"the permission mode\"" /var/lib/agentsim/events/events.jsonl && grep -q "\"gateway\":\"claude\".*\"reply\":\"once\"" /var/lib/agentsim/events/events.jsonl'

echo
echo "-- evaluation (run_solution.sh)"
EV=/var/lib/agentsim/events/events.jsonl
check T1 "each agent's turns are recorded by its gateway: prompt, model, tools and how each ended" \
  as_root 'for g in opencode codex claude; do jq -se --arg g $g "[.[] | select(.type==\"turn\" and .gateway==\$g and (.prompt|length) > 0)] | length > 0" '$EV' >/dev/null && jq -se --arg g $g "[.[] | select(.type==\"turn-end\" and .gateway==\$g and .model != null)] | length > 0" '$EV' >/dev/null || { echo "no turn record from $g"; exit 1; }; done'
check T2 "run_solution starts with the summary and lists every agent's turns" \
  R '/opt/agentsim/scripts/run_solution.sh > /tmp/run.txt; head -1 /tmp/run.txt | grep -qx "## SUMMARY" && for a in opencosmo cosmodex cosmo-code; do grep -Eq "^Turns \($a\): [1-9]" /tmp/run.txt || { echo "no turns for $a"; exit 1; }; done && grep -q "^## TURNS" /tmp/run.txt'
# The platform's provisioner (not part of this repository) extracts transcripts into
# .codesignal/<engine>/; pass its bundle to check that it reads all three engines' sessions.
if [ -n "${PROVISIONER_BUNDLE:-}" ]; then
  docker cp "$PROVISIONER_BUNDLE" "$NAME":/tmp/agent_provisioner.py >/dev/null
  R 'python3 /tmp/agent_provisioner.py extract >/tmp/extract.log 2>&1'
  for pair in E1:claude E2:codex E3:opencode; do
    id=${pair%%:*}; engine=${pair#*:}
    check "$id" "the provisioner extracts $engine sessions and run_solution prints them" \
      R "f=\$(ls .codesignal/$engine/interactions_summary.*.jsonl 2>/dev/null | head -1); [ -s \"\$f\" ] && /opt/agentsim/scripts/run_solution.sh | grep -q '## TIMELINE ($engine)'"
  done
else
  echo "SKIP  E1-3 transcript extraction (set PROVISIONER_BUNDLE to the provisioner's bundle)"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "all checks passed"; else echo "$FAILS check(s) failed"; fi
[ "$KEEP" = "--keep" ] || docker rm -f "$NAME" >/dev/null
exit $((FAILS > 0))
