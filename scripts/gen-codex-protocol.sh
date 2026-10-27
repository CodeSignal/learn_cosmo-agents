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
# The gateway's per-method parameter allowlist and the method list fixture, from the stable schema.
SCHEMA=$(mktemp -d)
docker run --rm -v "$SCHEMA:/out" cosmo-agents:dev sh -c 'cd /tmp && codex app-server generate-json-schema --out /out >/dev/null'
node scripts/gen-codex-params.mjs "$SCHEMA"
node -e 'const s=require(process.argv[1]+"/ClientRequest.json");const m=s.oneOf.map(v=>v.properties.method.const??v.properties.method.enum[0]).sort();require("fs").writeFileSync("test/fixtures/codex-app-server-methods.json",JSON.stringify({version:"see apps/cosmodex/src/protocol/VERSION",source:"codex app-server generate-json-schema (ClientRequest)",methods:m},null,1))' "$SCHEMA"
rm -rf "$SCHEMA"
