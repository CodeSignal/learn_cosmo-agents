// Minimal TOML writer for the policy files: strings, booleans, numbers, string arrays,
// and nested tables. Enough for requirements.toml; not a general serializer.

const str = (s) => JSON.stringify(s); // TOML basic strings share JSON's escapes for our inputs

function value(v) {
  if (typeof v === "string") return str(v);
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(value).join(", ")}]`;
  throw new Error(`unsupported TOML value: ${typeof v}`);
}

const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const key = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : str(k));

export function toToml(doc, path = []) {
  const lines = [];
  const tables = [];
  for (const [k, v] of Object.entries(doc)) {
    if (v === undefined) continue;
    if (isTable(v)) tables.push([k, v]);
    else lines.push(`${key(k)} = ${value(v)}`);
  }
  let out = lines.join("\n");
  for (const [k, v] of tables) {
    const p = [...path, key(k)];
    const body = toToml(v, p);
    const hasScalars = Object.values(v).some((x) => !isTable(x));
    out += `${out ? "\n\n" : ""}${hasScalars ? `[${p.join(".")}]\n` : ""}${body}`;
  }
  return out;
}
