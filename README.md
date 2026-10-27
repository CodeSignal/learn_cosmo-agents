# Cosmo Agents

A bespoke simulation that gives a learner or candidate an AI coding agent inside the task:
**OpenCosmo**, **Cosmodex** and **Cosmo Code**. Each is our own UI on top of a real, pinned
agent engine (OpenCode, Codex and Claude Code respectively), with every model request going
through the platform's LLM proxy and the engine locked down for the task.

> Status: foundation only. The shell, policy layer, supervisor and checks are in place; the
> agent UIs land next (OpenCosmo first).

## How it fits together

```
preview iframe (:3000)
  └─ shell (design system): agent switcher, help, status
       └─ /agents/<agent>/   the agent's UI (one frame per agent, kept alive on switch)
server (:3000, user agentsim)
  ├─ /api/session, /api/switch          the task's agents and the active one
  ├─ /engine/<agent>/*                  that engine's gateway: allowlist in, refusals logged
  └─ event log                          switches, blocked attempts
root supervisor                         keeps the server and engines running, evicts squatters
apply-policy (root, once)               task config -> root-owned engine policies
```

Three users matter:

| User | Runs | Can change |
|---|---|---|
| root | `apply-policy` (once), the supervisor | everything |
| `agentsim` | the server and gateways | its event log |
| session user (`runner`) | the engines and every tool call the agent makes | the workspace |

The agent's shell tools run as the session user, so anything that user owns is advisory. The
locks live where that user can't reach: root-owned policy files the engines treat as final, a
server running as another user, and the proxy key's model allowlist.

## Task configuration

The task ships `.codesignal/agent-sim.json`. A task can only narrow what
[`policy/pins.json`](policy/pins.json) allows.

```json
{
  "agents": ["opencosmo", "cosmodex", "cosmo-code"],
  "default": "opencosmo",
  "allowSwitch": false,
  "terminal": "off",
  "sandbox": true,
  "webTools": false,
  "permissions": { "preset": "ask", "bash": { "*": "ask", "npm test*": "allow" } },
  "models": {
    "opencosmo": { "allowed": ["anthropic/claude-sonnet-5-5"] }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `agents` | required | Agents offered in this task |
| `default` | first agent | Agent shown first |
| `allowSwitch` | `false` | Whether the learner may switch agents |
| `terminal` | `"off"` | `"sandboxed"` adds a terminal pane (workspace only, no network) |
| `sandbox` | `true` | Engine sandboxes for agent commands (needs user namespaces) |
| `webTools` | `false` | Web search and fetch tools |
| `models.<agent>.allowed` | all pinned | Models the agent may use; `default` picks the starting one |
| `permissions.preset` | `"engine-default"` | `"engine-default"`: each engine's own behaviour; `"ask"`: approve every edit and shell command; `"allow"`: no prompts |
| `permissions.edit` | from preset | `"ask"`, `"allow"` or `"deny"` for file edits |
| `permissions.bash` | from preset | One action for all shell commands, or `{ "<pattern>": action }` with `*` wildcards, later patterns winning |

Permission prompts look and work exactly as in the original app; every answer (once, always,
reject) is recorded in the event log. Cosmodex takes `permissions.preset` only: Codex approves by
policy, so per-command rules can't be applied there and are refused rather than ignored.

## Setup in a task

The image has the engines and this app preinstalled under `/opt/agentsim`. The task's setup
script runs, as the session user:

```bash
# Optional: your platform's own agent provisioning (user-level instructions, transcript
# extraction into .codesignal/<engine>/) runs first.
sudo -n /opt/agentsim/bin/apply-policy --config .codesignal/agent-sim.json
sudo -n /opt/agentsim/bin/agentsim-start
```

`OPENAI_BASE_URL`/`OPENAI_API_KEY` and `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` must be set for
the engines the task enables; `apply-policy` fails rather than let an engine bypass the proxy.
`run_solution.sh` calls `/opt/agentsim/scripts/run_solution.sh`, which prints the setup, the
event log and any extracted transcripts for evaluation.

## Development

```bash
git submodule update --init
npm install
npm run start:dev      # Vite on :3000, API on :3001, policy from dev/agent-sim.json
npm test               # unit tests (no Docker)
npm run test:container # builds the image and runs the lockdown checks in a container
```

## Licence

See [LICENSE](LICENSE). Code vendored from OpenCode keeps its MIT licence and notice.
