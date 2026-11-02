# Vendored OpenCode

Source: https://github.com/anomalyco/opencode, tag `v1.19.5` (commit `810c0eb`), MIT licence
(see `LICENSE` in this directory).

Included: the root workspace files (`package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`,
`patches/`) and the web app (`packages/app`) with every workspace package it depends on:
`ui`, `session-ui`, `sdk/js`, `core`, `schema`, `plugin`, `llm`, `http-recorder`,
`effect-drizzle-sqlite`, `effect-sqlite-node`. Nothing else from upstream.

The first commit that adds this directory is the pristine upstream copy. Every change for
OpenCosmo is a later commit, so `git log -p -- vendor/opencode` after that commit is the patch
series to re-apply on an upgrade:

1. Copy the same paths from the new upstream tag over this directory in one commit.
2. Re-apply (cherry-pick) the OpenCosmo commits and resolve conflicts.
3. Bump the OpenCode pin in `policy/pins.json` to the same version, rebuild, and run the parity
   checks.
