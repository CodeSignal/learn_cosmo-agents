// One-shot root helper: validates the task's agent-sim.json, renders the engine policies and
// writes them root-owned. Runs once per session (marker file); the candidate can call it later
// but it refuses. Installed root-owned under /opt/agentsim and reached through one sudoers line;
// see root/bin/apply-policy for the environment it gets.
//
// Exit codes: 0 applied, 2 invalid config, 3 environment/render problem, 4 already applied,
// 5 I/O error, 64 usage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateTaskConfig, engineOf } from "../policy/schema.mjs";
import { renderPolicy, RenderError } from "../policy/render.mjs";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
const MARKER = "/var/lib/agentsim/applied";

const isRoot = process.getuid?.() === 0;

function parseArgs(argv) {
  const args = { config: null, root: "", codexCatalogFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") args.config = argv[++i];
    // Test-only redirections; refused for root so the sudo path can't be steered.
    else if (a === "--root" && !isRoot) args.root = argv[++i];
    else if (a === "--codex-catalog-file" && !isRoot) args.codexCatalogFile = argv[++i];
    else return null;
  }
  return args.config ? args : null;
}

/** Read a small regular file without following a symlink, owned by the caller or root. */
function readOwnedFile(file, maxBytes, allowedUids) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (!allowedUids.includes(st.uid)) throw new Error("not owned by the calling user");
    if (st.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function callerHome() {
  const user = process.env.SUDO_USER;
  if (!user) return os.homedir();
  const line = fs.readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.split(":")[0] === user);
  return line ? line.split(":")[5] : null;
}

/** `codex debug models --bundled`, run as nobody in a throwaway CODEX_HOME. */
function codexBundledCatalog(args) {
  if (args.codexCatalogFile) return JSON.parse(fs.readFileSync(args.codexCatalogFile, "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentsim-codex-"));
  fs.chmodSync(tmp, 0o777);
  try {
    const res = spawnSync("codex", ["debug", "models", "--bundled"], {
      cwd: tmp,
      env: { PATH: process.env.PATH, HOME: tmp, CODEX_HOME: tmp },
      encoding: "utf8",
      timeout: 60_000,
      ...(isRoot ? { uid: 65534, gid: 65534 } : {}),
    });
    if (res.status !== 0) return null;
    return JSON.parse(res.stdout);
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  if (isRoot) fs.chownSync(tmp, 0, 0);
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, file);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("usage: apply-policy --config <agent-sim.json>");
    return 64;
  }
  const at = (p) => (args.root ? path.join(args.root, p) : p);

  if (fs.existsSync(at(MARKER))) {
    console.error("policy already applied for this session; refusing to change it");
    return 4;
  }

  const callerUid = Number(process.env.SUDO_UID ?? process.getuid());
  let raw;
  try {
    raw = JSON.parse(readOwnedFile(args.config, MAX_CONFIG_BYTES, [callerUid, 0]));
  } catch (e) {
    // Never echo file content: the path is caller-chosen.
    console.error(`cannot read ${args.config}: ${e instanceof SyntaxError ? "not valid JSON" : e.message}`);
    return 2;
  }
  const result = validateTaskConfig(raw);
  if (!result.ok) {
    for (const err of result.errors) console.error(`config: ${err}`);
    return 2;
  }
  const config = result.config;
  const engines = new Set(config.agents.map((a) => engineOf(a)));

  const inputs = {};
  if (engines.has("codex")) inputs.codexBundledCatalog = codexBundledCatalog(args);
  if (engines.has("opencode")) {
    // Carry the user-level instructions layer (if one was provisioned) into the root-owned
    // config home OpenCode will read from.
    const home = callerHome();
    const file = home && path.join(home, ".config", "opencode", "AGENTS.md");
    try {
      if (file && fs.existsSync(file)) inputs.opencodeInstructions = readOwnedFile(file, MAX_INSTRUCTIONS_BYTES, [callerUid, 0]);
    } catch (e) {
      console.error(`skipping OpenCode instructions: ${e.message}`);
    }
  }

  let rendered;
  try {
    rendered = renderPolicy(config, { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }, inputs);
  } catch (e) {
    if (!(e instanceof RenderError)) throw e;
    for (const err of e.errors) console.error(`environment: ${err}`);
    return 3;
  }

  try {
    for (const dir of rendered.dirs) {
      fs.mkdirSync(at(dir), { recursive: true, mode: 0o755 });
      if (isRoot) fs.chownSync(at(dir), 0, 0);
      fs.chmodSync(at(dir), 0o755);
    }
    for (const f of rendered.files) writeAtomic(at(f.path), f.content);
    fs.mkdirSync(path.dirname(at(MARKER)), { recursive: true, mode: 0o755 });
    fs.writeFileSync(at(MARKER), new Date().toISOString() + "\n", { mode: 0o644, flag: "wx" });
  } catch (e) {
    console.error(`writing policy failed: ${e.message}`);
    return 5;
  }

  console.log(`policy applied: agents ${config.agents.join(", ")} (default ${config.default}); ${rendered.files.length} files`);
  return 0;
}

process.exitCode = main();
