# Runbook: engine version bumps and re-checking the UIs

The engines are pinned in [`policy/pins.json`](../policy/pins.json); that file is the only place
their versions and model lists live. Every bump is a change of its own, with the checks below.

## 1. Bump the pin

| Engine | Change | Must match |
|---|---|---|
| OpenCode | `engines.opencode.version` | the vendored UI kit in `vendor/opencode` (same tag), so OpenCosmo speaks the server's API |
| Codex | `engines.codex.version` | Cosmodex's generated protocol types (step 2) |
| Claude Code | `engines.claude.version` (2.1.N) | `@anthropic-ai/claude-agent-sdk` 0.3.N in `engines/claude-host/package.json` and its lockfile (a unit test checks the pair) |

Models: add or remove ids in the engine's `models`. A task can only narrow this list, so removing
a model a task names makes that task's config invalid; `validateTaskConfig` reports it.

## 2. Regenerate what's derived from the engine

- **Codex:** build the image, then `sh scripts/gen-codex-protocol.sh`. It rewrites
  `apps/cosmodex/src/protocol/`, the gateway's parameter allowlist
  (`server/gateways/codex-params.json`) and the method fixture
  (`test/fixtures/codex-app-server-methods.json`). The unit tests then fail for every client
  method the gateway hasn't classified: decide each one in `server/gateways/codex-methods.mjs`
  (allow, terminal, or the reason it's refused).
- **OpenCode:** compare the server's routes with `server/gateways/opencode-routes.mjs`. Routes
  not listed are refused and logged as `unrouted` by the gateway, so look for those in the server
  output while exercising OpenCosmo.
- **Claude Code:** check the Agent SDK's changelog for changed options, message types and
  `system` subtypes the engine host and the UI rely on (`init`, `task_*`, `result`), and for new
  managed-settings keys the lockdown should set.

## 3. Run the checks

```bash
npm test
sh scripts/build-ui.sh
PROVISIONER_BUNDLE=<extractor bundle> npm run test:container
sh scripts/dev-container.sh && npm run test:ui
```

The container checks cover the lockdown (red-team items `R*`), setup guarantees (`S*`), each
agent's flows (`O*` OpenCosmo, `X*` Cosmodex, `C*` Cosmo Code, `P*` permissions), the turn record
and evaluation output (`T*`) and transcript extraction (`E*`). All must pass. `test:ui` (needs a
local Chrome) opens each agent in a headless browser, sends a prompt that runs a command,
approves it and waits for the reply (`U*`); it saves a screenshot per agent.

Then run once against the real model proxy with a key scoped to the task's models: start a
session in each agent, send one prompt that runs a command, approve it, and read
`run_solution.sh`'s output.

## 4. Re-check the UIs against the originals

Each UI follows its original app's structure and behaviour. After a bump, open the original
app at the new version side by side with ours (same task config, same stand-in proxy) and walk
these flows in each agent. Note what differs and fix it, or record why it stays different.

- New session, a prompt, streaming reply, stop.
- A command that needs approval: allow once, always allow, deny.
- Plan mode: the plan card, approving and rejecting a plan; questions from the agent.
- Edits: the change list and diff, undo or rewind where the original has it.
- Slash commands and @ file mentions; the command palette.
- Panes: changes, files, terminal (when the task enables it), preview where present.
- Settings: every page; locked rows show the task's reason.
- Session actions: rename, fork, archive; sidebar grouping and sorting.
- Keyboard shortcuts from the original's shortcut list.
- Light and dark theme (from the system), and a narrow window.

Locked or missing features must look the way the original shows a managed or unavailable
setting, never as an error.

## 5. Ship

Merge only with every check green. Note in the change what the parity walk found.
