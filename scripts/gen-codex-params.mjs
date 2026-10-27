// Writes server/gateways/codex-params.json: for every client method of the pinned codex
// app-server, the parameter names its *stable* schema declares. The gateway refuses any other
// parameter (experimental ones need an explicit entry in codex.mjs).
//   node scripts/gen-codex-params.mjs <dir from `codex app-server generate-json-schema --out`>
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: gen-codex-params.mjs <schema dir>");
  process.exit(64);
}
const schema = JSON.parse(fs.readFileSync(path.join(dir, "ClientRequest.json"), "utf8"));
const defs = schema.definitions ?? schema.$defs ?? {};
const resolve = (node) => (node?.$ref ? defs[node.$ref.split("/").pop()] : node);
const out = {};
for (const variant of schema.oneOf) {
  const m = variant.properties.method;
  const method = m.const ?? m.enum?.[0];
  let params = variant.properties.params ?? {};
  params = resolve(params.anyOf ? params.anyOf.find((x) => x.$ref || x.properties) : params) ?? {};
  out[method] = Object.keys(params.properties ?? {}).sort();
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(new URL("../server/gateways/codex-params.json", import.meta.url), JSON.stringify(sorted, null, 1) + "\n");
console.log(`wrote parameter lists for ${Object.keys(sorted).length} methods`);
