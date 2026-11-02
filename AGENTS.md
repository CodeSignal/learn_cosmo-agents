# AGENTS guide

Guidance for contributors and AI agents working in this repository.

## Layout

- `policy/`: `pins.json` (engine versions and allowed models, the only place they live; OpenCode
  `definitions` describe models newer than its own catalog),
  `schema.mjs` (task config validation), `render.mjs` (engine policy files, pure),
  `toml.mjs`.
- `root/`: code that runs as root in root mode. `apply-policy.mjs` (one-shot), `supervisor.mjs`
  (also user mode: `--user --config`, everything as the session user),
  `procnet.mjs` + `find-owners.mjs` (who holds a port), `bin/` sudo entry points, `sudoers`,
  `install.sh` (installs an unpacked release as root).
- `server/`: the :3000 server (`index.mjs`), engine gateways (`gateway.mjs`), event log.
- `client/`: the shell page (design system, Vite). `client/design-system` is a submodule.
- `image/Dockerfile`: the runtime image, installing the release tarball it builds.
  `scripts/pack-release.mjs` + `verify-release.mjs`: the tarball and its boot check;
  `.github/workflows/release.yml` publishes it. `scripts/run_solution.sh`: output for evaluation.
- `test/`: unit tests (`*.test.mjs`), `stub-gateway.mjs` (a fake LLM proxy), `container/run.sh`
  (root mode), `stock/run.sh` (user mode on a stand-in for the platform's standard image).
- `.codesignal/`: the base task's setup and run scripts (copies of the base task's files);
  `scripts/session-setup.sh` is what setup runs from the release.

## Rules

- **Two modes.** The platform's standard image gives setup no root, so tasks run in user mode
  (README, "What holds without root"): every lock must also hold through the gateways or a
  policy the supervisor hands an engine from memory, never only through a file the session user
  can edit. Root mode adds root-owned policies and user separation on top.

- **The session user is the attacker model.** The agent runs shell commands as that user, so
  anything it owns can be changed. A lock only counts if it lives in a root-owned file, in a
  process running as another user, or in the proxy.
- **Root code is installed root-owned and takes no code or paths from the workspace.** The sudo
  wrappers start Node with an empty environment plus named variables. `--root` and
  `--codex-catalog-file` exist for tests and are refused when running as root.
- **A task narrows, never widens.** Every model must be in `policy/pins.json`; validation reports
  every problem at once.
- **No silent proxy bypass.** An enabled engine without its proxy URL fails `apply-policy`.
- **Keys never go into files.** Policies carry base URLs only; keys stay in the environment.
- **Gateways default to deny.** Every refusal is answered as `{ "blocked": true, "reason" }` and
  logged; the UIs show it the way the original app shows a managed or failed action.
- **Root can't read other users' `/proc/<pid>/fd` in a container without CAP_SYS_PTRACE.**
  To find a port's owner, the supervisor runs `find-owners.mjs` as the socket's uid and only
  acts on pids that really run as that uid.
- **Public repository.** Generic platform contract only: no internal links, ids, hostnames or
  people; no vendor screenshots.
- Dependencies stay minimal (Node built-ins on the server; Vite for the client build).
- **Entry points are bundled for release.** Import JSON (`with { type: "json" }`) rather than
  reading it beside the module, and resolve other files from the install root as the supervisor
  does; `npm run verify:release` catches what a bundle can't find.

## Checks

- `npm test` before every commit.
- `npm run test:container` and `sh test/stock/run.sh` for anything under `root/`, `policy/`,
  `image/` or the server's process model. Each check is named after the red-team item it covers (`R10`, `R11*`) or is a
  setup guarantee (`S*`).
