#!/bin/sh
# Regenerates Cosmodex's protocol types from the pinned Codex (run after a Codex pin bump).
# Needs the simulation image built (it has the pinned codex installed). Experimental types are
# included: plan mode and questions live there (the gateway opts in to the experimental API).
set -eu
cd "$(dirname "$0")/.."
OUT=apps/cosmodex/src/protocol
rm -rf "$OUT" && mkdir -p "$OUT"
docker run --rm -v "$PWD/$OUT:/out" cosmo-agents:dev sh -c 'cd /tmp && codex app-server generate-ts --experimental --out /out >/dev/null'
docker run --rm cosmo-agents:dev codex --version > "$OUT/VERSION"
echo "regenerated $(find "$OUT" -name '*.ts' | wc -l) files for $(cat "$OUT/VERSION")"
