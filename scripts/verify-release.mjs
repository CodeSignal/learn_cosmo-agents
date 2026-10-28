#!/usr/bin/env node
// Proves a release tarball runs: unpacks it somewhere clean and runs each bundled entry point the
// way the simulation does, without the engines (the container suite covers those).
//   node scripts/verify-release.mjs [release.tar.gz]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tarball = path.resolve(process.argv[2] ?? "release.tar.gz");
const PORT = Number(process.env.VERIFY_PORT ?? 3399);
const HOST_PORT = PORT + 1;
// Real path: the bundles start only when run by their own path (macOS tmp is a symlink).
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cosmo-release-")));
const children = [];

const step = (text) => console.log(`  ${text}`);
function fail(message) {
  console.error(`\n✗ ${message}`);
  cleanup();
  process.exit(1);
}
function cleanup() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(work, { recursive: true, force: true });
}

/** Starts a bundled script and resolves once its output matches `ready`. */
function boot(file, env, ready) {
  const child = spawn(process.execPath, [file], { cwd: work, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let log = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${file} did not start:\n${log}`)), 15000);
    const on = (d) => {
      log += d;
      if (ready.test(log)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    child.on("exit", (code) => reject(new Error(`${file} exited (${code}):\n${log}`)));
  });
}

async function get(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
}

async function main() {
  if (!fs.existsSync(tarball)) fail(`no tarball at ${tarball}; build one with npm run pack`);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  const bad = entries.filter((e) => /(^|\/)(\._|\.DS_Store$|node_modules\/)|\.map$|(^|\/)\.\.(\/|$)/.test(e) || e.startsWith("/"));
  if (bad.length) fail(`the tarball carries files it shouldn't, e.g. ${bad[0]}`);
  execFileSync("tar", ["-xzf", tarball, "-C", work]);
  step(`unpacked ${entries.length} entries; no node_modules, source maps or macOS metadata`);

  const required = [
    "server/index.mjs", "root/apply-policy.mjs", "root/supervisor.mjs", "root/find-owners.mjs",
    "engines/claude-host/host.mjs", "engines/claude-host/package-lock.json", "scripts/summary.mjs", "scripts/run_solution.sh",
    "bin/apply-policy", "bin/agentsim-start", "bin/terminal-shell", "sudoers", "install.sh", "policy/pins.json",
    "dist/index.html", "dist-agents/opencosmo/index.html", "dist-agents/cosmodex/index.html", "dist-agents/cosmo-code/index.html",
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(work, f)));
  if (missing.length) fail(`missing from the tarball:\n    ${missing.join("\n    ")}`);
  step(`all ${required.length} runtime paths present`);

  // apply-policy, as the unit tests run it: against a scratch root, with a stand-in Codex catalog.
  const scratch = fs.mkdtempSync(path.join(work, "apply-"));
  const config = path.join(scratch, "agent-sim.json");
  fs.writeFileSync(config, JSON.stringify({ agents: ["opencosmo", "cosmodex", "cosmo-code"], allowSwitch: true }));
  const pins = JSON.parse(fs.readFileSync(path.join(work, "policy/pins.json"), "utf8"));
  const catalog = path.join(scratch, "catalog.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: pins.engines.codex.models.map((slug) => ({ slug, supported_in_api: true })) }));
  const applied = spawnSync(process.execPath, [path.join(work, "root/apply-policy.mjs"), "--root", path.join(scratch, "root"), "--codex-catalog-file", catalog, "--config", config], {
    env: { PATH: process.env.PATH, OPENAI_BASE_URL: "https://proxy.test/v1", ANTHROPIC_BASE_URL: "https://proxy.test" },
    encoding: "utf8",
  });
  const policyFile = path.join(scratch, "root/etc/agentsim/policy.json");
  if (applied.status !== 0 || !fs.existsSync(policyFile)) fail(`apply-policy failed (${applied.status}):\n${applied.stderr}`);
  step("apply-policy wrote the engine policies");

  // The supervisor loads (it starts its services from paths beside it, checked above).
  const supervisor = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(path.join(work, "root/supervisor.mjs"))}); if (typeof m.services !== "function") process.exit(3);`], { encoding: "utf8" });
  if (supervisor.status !== 0) fail(`the supervisor bundle did not load:\n${supervisor.stderr}`);
  step("the supervisor bundle loads");

  // The engine host, with its dependencies installed as the image installs them; it loads the Agent
  // SDK and listens (it needs the engine only for a turn).
  const host = path.join(work, "engines/claude-host");
  const ci = spawnSync("npm", ["ci", "--omit=optional", "--no-fund", "--no-audit"], { cwd: host, encoding: "utf8" });
  if (ci.status !== 0) fail(`npm ci for the engine host failed:\n${ci.stderr}`);
  await boot(path.join(work, "engines/claude-host/host.mjs"), { COSMO_CODE_PORT: String(HOST_PORT), COSMO_CODE_TOKEN: "verify", WORKSPACE: scratch, HOME: scratch }, /engine host on/).catch((e) => fail(e.message));
  step("the Cosmo Code engine host starts with its dependencies from the shipped lockfile");

  // The server, as the supervisor starts it: the applied policy, a fresh event log, the engine host
  // (the engines themselves run only in the image: the container suite drives them).
  const events = path.join(scratch, "events");
  await boot(path.join(work, "server/index.mjs"), { PORT: String(PORT), IS_PRODUCTION: "true", POLICY_PATH: policyFile, EVENTS_DIR: events, WORKSPACE: scratch, CLAUDE_HOST_URL: `ws://127.0.0.1:${HOST_PORT}/?token=verify` }, /agentsim server on/).catch((e) => fail(e.message));
  const session = JSON.parse((await get("/api/session")).text);
  if (session.agents?.length !== 3 || session.active !== "opencosmo") fail(`/api/session: ${JSON.stringify(session).slice(0, 300)}`);
  const shell = await get("/");
  if (shell.status !== 200 || !shell.type.startsWith("text/html")) fail(`the shell page answered ${shell.status}`);
  for (const agent of ["opencosmo", "cosmodex", "cosmo-code"]) {
    const page = await get(`/agents/${agent}/`);
    const script = /<script[^>]+src="([^"]+\.js)"/.exec(page.text)?.[1];
    if (page.status !== 200 || !script) fail(`/agents/${agent}/ answered ${page.status} without a script`);
    const asset = await get(script.startsWith("/") ? script : `/agents/${agent}/${script}`);
    if (asset.status !== 200 || !/javascript/.test(asset.type)) fail(`${agent}'s ${script} answered ${asset.status} (${asset.type})`);
  }
  step("the server serves the shell, the session and all three agent UIs");

  const summary = spawnSync(process.execPath, [path.join(work, "scripts/summary.mjs"), "--policy", policyFile, "--events", path.join(events, "events.jsonl"), "--supervisor", path.join(scratch, "none")], { encoding: "utf8" });
  if (summary.status !== 0 || !/^## SUMMARY\nAgents: opencosmo \(default\)/.test(summary.stdout) || !/session-start|## TURNS/.test(summary.stdout)) fail(`summary.mjs:\n${summary.stdout}${summary.stderr}`);
  step("run_solution's summary prints from the records");

  console.log("\n✓ the release runs");
  cleanup();
}

main().catch((error) => fail(error.stack ?? String(error)));
