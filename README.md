# Cosmo Agents

A bespoke simulation that gives a learner or candidate an AI coding agent inside the task:
**OpenCosmo**, **Cosmodex** and **Cosmo Code**. Each is our own UI on top of a real, pinned
agent engine (OpenCode, Codex and Claude Code respectively), with every model request going
through the platform's LLM proxy and the engine locked down for the task.

Each UI follows its original app's structure and behaviour closely, so a learner who knows the
original needs no time to get used to it, with the platform's design system and the user's light
or dark theme.

> Status: all three agents work end to end on their engines, and CI publishes releases.
> Remaining: the platform's task template.

## How it fits together

```
preview iframe (:3000)
  └─ shell (design system): agent switcher, help, status
       └─ /agents/<agent>/   the agent's UI (one frame per agent, kept alive on switch)
server (:3000, user agentsim)
  ├─ /api/session, /api/switch          the task's agents and the active one
  ├─ /api/workspace/diff, …/preview/    the workspace's changes; files for a UI's preview
  ├─ /engine/<agent>/*                  that engine's gateway: allowlist in, refusals logged
  └─ event log                          turns, switches, permission answers, blocked attempts
engines (session user)
  ├─ opencode serve                     behind a filtering HTTP proxy
  ├─ codex app-server                   behind a JSON-RPC method allowlist
  └─ Claude Agent SDK host              behind a JSON-RPC method allowlist
root supervisor                         keeps the server and engines running, evicts squatters
apply-policy (root, once)               task config -> root-owned engine policies
```

Requests that change something are refused when the browser marks them as coming from another
site or from a sandboxed page (a previewed file the agent wrote), so a page can't answer the
agent's permission prompts.

The agent's shell tools run as the session user. How far the locks reach depends on whether
setup has root: see [Setup in a task](#setup-in-a-task).

## Task configuration

The task ships `.codesignal/agent-sim.json`. A task can only narrow what
[`policy/pins.json`](policy/pins.json) allows.

```json
{
  "agents": ["opencosmo", "cosmo-code"],
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
| `permissions.preset` | `"ask"` | `"ask"`: approve every edit and shell command; `"engine-default"`: each engine's own behaviour; `"allow"`: no prompts |
| `permissions.edit` | from preset | `"ask"`, `"allow"` or `"deny"` for file edits |
| `permissions.bash` | from preset | One action for all shell commands, or `{ "<pattern>": action }` with `*` wildcards, later patterns winning |

Permission prompts look and work exactly as in the original app; every answer (once, always,
reject) is recorded in the event log. Cosmodex takes `permissions.preset` only: Codex approves by
policy, so per-command rules can't be applied there and are refused rather than ignored.

## Setup in a task

The platform's standard task image runs setup as the session user, without root, so the
simulation runs in **user mode**. The base task's [`.codesignal/setup.sh`](.codesignal/setup.sh)
downloads the release for the channel (`APP_ENVIRONMENT`), unpacks it in the session user's home
(`~/.cosmo-agents`, outside the workspace, so the editor shows only the task's files) and runs
`scripts/session-setup.sh` from it, which:

1. installs the pinned engines the task's agents use with npm, into `~/.cosmo-agents/engines`,
   and the engine host's dependencies (about 30 seconds);
2. starts the supervisor in user mode: it validates `.codesignal/agent-sim.json` once, renders
   every engine's policy into memory, starts the server and the engines and restarts them if
   they stop;
3. returns once the server on :3000 answers.

[`.codesignal/README.md`](.codesignal/README.md) has the base task's settings.
`OPENAI_BASE_URL`/`OPENAI_API_KEY` and `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` must be set for
the engines the task enables (the LLM proxy sets them); setup fails rather than let an engine
bypass the proxy.

### What holds without root

Everything runs as the session user, as with the platform's terminal agent provisioning, so
files that user owns are advisory. What the candidate and the agent can't get around:

- **The gateways.** Every request a UI sends passes the server's allowlists: models, permission
  modes, approval policies and sandboxes outside the task are refused, as are configuration,
  sign-in, MCP and files outside the workspace. The UIs show refusals like the original's
  managed settings.
- **Policies from memory.** Each engine gets the task's policy from the supervisor when it
  starts (OpenCode as inline config, Codex as `-c` overrides, Cosmo Code as policy-tier settings
  from the engine host), so editing a config file on disk changes nothing the running session
  enforces. User- and project-level config files still load, as with any user-level setup.
- **Permission prompts** (`permissions` in the task config): with the default `ask`, the agent
  can only change a file or run a command the candidate approves.
- **The proxy key's model allowlist.**

The supervisor restarts an engine or server that stops, and replaces a process that takes over
their ports, but the agent runs as the same user and could stop the supervisor too. The
engines' command sandboxes need `bwrap`; when the image has none, setup unpacks the
distribution's package if it can, and agents' commands otherwise run unsandboxed.

### Root mode

With an image that preinstalls the app under `/opt/agentsim` and lets setup use two sudo
helpers, the simulation runs locked down: root-owned policy files the engines treat as final,
the server as its own user, and a root supervisor.

```bash
sudo -n /opt/agentsim/bin/apply-policy --config .codesignal/agent-sim.json
sudo -n /opt/agentsim/bin/agentsim-start
```

Three users matter there:

| User | Runs | Can change |
|---|---|---|
| root | `apply-policy` (once), the supervisor | everything |
| `agentsim` | the server and gateways | its event log |
| session user (`runner`) | the engines and every tool call the agent makes | the workspace |

`test/container/run.sh` checks that mode; `test/stock/run.sh` checks user mode on a stand-in for
the standard image.

## Evaluation output

`run_solution.sh` prints, in this order:

1. `## SUMMARY`: the task's agents and settings, then per agent the number of turns and how
   they ended, the tools used, permission answers, refusals by reason, tampering and engine
   restarts. The same records always give the same lines.
2. `## TURNS`: one line per prompt: time, agent, session, the prompt (JSON-quoted), how the turn
   ended and the tools it used.
3. The applied setup, the raw event log and the supervisor's log.
4. Transcripts extracted into `.codesignal/<engine>/`, if the task's setup extracts them.

Sections 1–3 come from files the session user can't change: each gateway records turns from the
engine's own traffic. Extracted transcripts live in the workspace and can be edited, so grading
that must hold up should rely on the first three.

## Development

```bash
git submodule update --init
npm install
npm run start:dev      # Vite on :3000, API on :3001, policy from dev/agent-sim.json
npm test               # unit tests (no Docker)
npm run test:container # builds the image and runs the lockdown checks in a container
sh scripts/build-ui.sh # builds the three agent UIs into dist-agents/ (Bun in Docker)
sh scripts/dev-container.sh   # a local container with a stand-in LLM proxy, on :3010
sh test/stock/run.sh   # user mode on a stand-in for the platform's standard image, on :3020
npm run test:ui        # drives each agent UI in headless Chrome against that container
npm run build && npm run pack   # release.tar.gz from dist/ and dist-agents/
npm run verify:release          # unpacks release.tar.gz and boots it
```

`PROVISIONER_BUNDLE=<path to a transcript extractor bundle> npm run test:container` also checks
that transcripts of all three engines are extracted. [`docs/runbook.md`](docs/runbook.md) covers
engine version bumps and re-checking the UIs against the originals.

## Releases

Every push to `main` runs [the release workflow](.github/workflows/release.yml): unit tests, the
release tarball (built inside the image build, so the checked image installs exactly what
ships), a boot of the unpacked tarball, the container checks and the UI smoke test. Only then
does it publish `vN` as a pre-release and move the floating `prerelease` tag to it. Pull requests
run the same checks without publishing.

`release.tar.gz` unpacks as `/opt/agentsim`: one minified file per entry point (server, root
helpers, engine host, summary), the built shell and agent UIs, the sudo entry points, the sudoers
entry and `install.sh`. It carries no `node_modules`. The engine host's dependencies (the Agent SDK
among them) are installed from its shipped lockfile with `npm ci`, as the engines are.

The app runs root-owned from the image, so a session never downloads it. The channel is picked
when the image is built:

| Channel | Release |
|---|---|
| staging | `https://github.com/CodeSignal/learn_cosmo-agents/releases/download/prerelease/release.tar.gz` |
| production | `https://github.com/CodeSignal/learn_cosmo-agents/releases/latest/download/release.tar.gz` |

An image installs a release the way [`image/Dockerfile`](image/Dockerfile) does: the engines at
the versions in the release's `policy/pins.json`, then unpack into `/opt/agentsim`,
`npm ci --omit=optional` in `engines/claude-host`, and `sh /opt/agentsim/install.sh` as root.
Promote a build to production with `gh release edit vN --prerelease=false --latest`.

## Licence

See [LICENSE](LICENSE). Code vendored from OpenCode keeps its MIT licence, and the types generated
from the Codex protocol are Apache-2.0: see [NOTICE](NOTICE).
