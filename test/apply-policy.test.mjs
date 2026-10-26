// Runs the real helper as the current (non-root) user against a temporary root prefix.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PINS } from "../policy/schema.mjs";

const HELPER = new URL("../root/apply-policy.mjs", import.meta.url).pathname;
const ENV = { PATH: process.env.PATH, OPENAI_BASE_URL: "https://proxy.test/v1", ANTHROPIC_BASE_URL: "https://proxy.test" };

function sandbox(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-"));
  const cfg = path.join(dir, "agent-sim.json");
  fs.writeFileSync(cfg, typeof config === "string" ? config : JSON.stringify(config));
  const catalog = path.join(dir, "catalog.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: PINS.engines.codex.models.map((slug) => ({ slug, supported_in_api: true })) }));
  const root = path.join(dir, "root");
  const run = (env = ENV, extra = []) =>
    spawnSync(process.execPath, [HELPER, "--root", root, "--codex-catalog-file", catalog, "--config", cfg, ...extra], { env, encoding: "utf8" });
  return { dir, cfg, root, run };
}

test("applies once, writes 0644 files, then refuses", () => {
  const s = sandbox({ agents: ["opencosmo", "cosmodex", "cosmo-code"] });
  const first = s.run();
  assert.equal(first.status, 0, first.stderr);
  for (const p of ["etc/agentsim/policy.json", "etc/opencode/opencode.json", "etc/codex/requirements.toml", "etc/codex/models.json", "etc/claude-code/managed-settings.json"]) {
    const st = fs.statSync(path.join(s.root, p));
    assert.equal(st.mode & 0o777, 0o644, p);
  }
  const second = s.run();
  assert.equal(second.status, 4);
  assert.match(second.stderr, /already applied/);
});

test("invalid config: exit 2 with every error, nothing written", () => {
  const s = sandbox({ agents: ["cosmodex"], models: { cosmodex: { allowed: ["gpt-6-astra"] } }, typo: true });
  const r = s.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gpt-6-astra/);
  assert.match(r.stderr, /unknown key "typo"/);
  assert.equal(fs.existsSync(s.root), false);
});

test("missing proxy route: exit 3, nothing written", () => {
  const s = sandbox({ agents: ["cosmodex"] });
  const r = s.run({ PATH: process.env.PATH });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /OPENAI_BASE_URL/);
  assert.equal(fs.existsSync(path.join(s.root, "var/lib/agentsim/applied")), false);
});

test("config must be a regular file, not a symlink; file content is never echoed", () => {
  const s = sandbox("SECRET-CONTENT{not json");
  const bad = s.run();
  assert.equal(bad.status, 2);
  assert.doesNotMatch(bad.stderr, /SECRET-CONTENT/);
  const link = path.join(s.dir, "link.json");
  fs.symlinkSync(s.cfg, link);
  const r = spawnSync(process.execPath, [HELPER, "--root", s.root, "--config", link], { env: ENV, encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("unknown arguments are a usage error", () => {
  const s = sandbox({ agents: ["cosmo-code"] });
  assert.equal(s.run(ENV, ["--force"]).status, 64);
});
