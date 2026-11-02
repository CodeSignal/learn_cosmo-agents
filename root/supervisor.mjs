// Root supervisor. Starts the simulation's processes under their own users, restarts any that
// die, and kills a process that takes over a supervised port (an agent can kill an engine it
// owns and start its own copy without the lockdown; this undoes that and logs it).
//
//   supervisor.mjs --daemon   detach and run in the background (what agentsim-start calls)
//   supervisor.mjs            run in the foreground
//
// Without root (a platform image where setup runs as the session user), `--user --config
// <agent-sim.json>` runs everything as that user: the supervisor validates the task config
// itself and hands each engine its policy as it starts it (policy/render.mjs, renderUserPolicy).
// Its state lives under `--state` (default ~/.cosmo-agents), outside the workspace.
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listeningSockets, readTables, pidsForInodes, uidOf, descendsFrom } from "./procnet.mjs";
import { validateTaskConfig } from "../policy/schema.mjs";
import { renderUserPolicy, RenderError } from "../policy/render.mjs";
import { bundledCodexCatalog } from "./codex-catalog.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const USER_MODE = process.argv.includes("--user");
const BASE = path.resolve(argValue("--state") ?? path.join(os.homedir(), ".cosmo-agents"));
const RUN_DIR = USER_MODE ? `${BASE}/run` : "/run/agentsim";
const PID_FILE = `${RUN_DIR}/supervisor.pid`;
const LOG_DIR = USER_MODE ? `${BASE}/log` : "/var/log/agentsim";
const STATE_DIR = USER_MODE ? `${BASE}/state` : "/var/lib/agentsim";
const EVENTS_DIR = `${STATE_DIR}/events`;
// In user mode a record of the applied config (for run_solution); the processes get it from memory.
const POLICY = USER_MODE ? `${STATE_DIR}/policy.json` : "/etc/agentsim/policy.json";
const ENGINE_ENV = "/etc/agentsim/engine-env.json";
const SESSION_USER = "runner";
const WORKSPACE = "/usercode/FILESYSTEM";
const OPENCODE_PORT = 4096;
const CODEX_PORT = 4500;
const CLAUDE_PORT = 4600;
// Proxy route and keys, handed to the engines only (never to the server).
const PROXY_ENV = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
const MARKER = `${STATE_DIR}/applied`;
const CHECK_MS = 2000;
const MAX_BACKOFF_MS = 10_000;

const log = (type, detail = {}) => {
  const line = JSON.stringify({ at: new Date().toISOString(), source: "supervisor", type, ...detail });
  fs.appendFileSync(`${STATE_DIR}/supervisor.jsonl`, line + "\n");
  console.log(line);
};

function passwd() {
  return fs.readFileSync("/etc/passwd", "utf8").split("\n").filter(Boolean).map((l) => {
    const [name, , uid, gid, , home] = l.split(":");
    return { name, uid: Number(uid), gid: Number(gid), home };
  });
}

function account(user) {
  const acct = passwd().find((a) => a.name === user);
  if (!acct) throw new Error(`no such user: ${user}`);
  return acct;
}

/**
 * PIDs holding a socket owned by `uid`. Root tries /proc directly; without CAP_SYS_PTRACE that
 * fails for other users' processes, so the lookup is repeated as that uid. Only pids that
 * really run as `uid` are returned, whatever the helper prints.
 */
function socketOwners(inode, uid) {
  let pids = [...pidsForInodes(new Set([inode]))];
  if (!pids.length && uid !== 0 && process.getuid() === 0) {
    const acct = passwd().find((a) => a.uid === uid);
    const res = spawnSync(process.execPath, [path.join(APP, "root", "find-owners.mjs"), inode], {
      uid,
      gid: acct ? acct.gid : uid,
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 5000,
    });
    try {
      pids = JSON.parse(res.stdout);
    } catch {
      pids = [];
    }
  }
  return pids.filter((pid) => Number.isInteger(pid) && uidOf(pid) === uid);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function which(bin) {
  // In user mode the engines are wherever npm installs global packages (on the caller's PATH).
  const dirs = USER_MODE ? (process.env.PATH ?? "").split(":").filter(Boolean) : ["/usr/local/bin", "/usr/bin", "/bin"];
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, bin))) return path.join(dir, bin);
  }
  throw new Error(`${bin} is not installed`);
}

/**
 * The workspace as a git repository (engines show changes against it), with the task's own
 * files (.codesignal, main.sh) in the repo-local exclude list, so they stay out of change lists and file
 * search (cosmetic: the agent can still read them).
 */
function gitWorkspace() {
  const script = [
    "[ -d .git ] || git init -q",
    'f=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$f")"',
    ...["/.codesignal/", "/main.sh"].map((p) => `{ grep -qxF "${p}" "$f" 2>/dev/null || echo "${p}" >> "$f"; }`),
  ].join(" && ");
  if (USER_MODE) return spawnSync("sh", ["-c", script], { cwd: WORKSPACE, env: { PATH: "/usr/bin:/bin", HOME: os.homedir() } });
  const acct = account(SESSION_USER);
  spawnSync("sh", ["-c", script], { cwd: WORKSPACE, uid: acct.uid, gid: acct.gid, env: { PATH: "/usr/bin:/bin", HOME: acct.home } });
}

// The task's own files in the workspace: an agent may read them but never change them.
const TASK_FILES = [".codesignal", "main.sh"];

/**
 * User mode: the filesystem and processes an engine (and every command its agent runs) sees. The
 * workspace is writable except the task's own files; the rest of /usercode is hidden, and so is
 * the simulation's folder in the home except the engines and the release code (state, logs and
 * records stay out of reach). The engine sees only its own processes, so neither the server nor
 * this supervisor, nor their secrets in /proc.
 */
export function engineView({ home = os.homedir(), base = BASE, app = APP, workspace = WORKSPACE, visible = [], exists = fs.existsSync } = {}) {
  const ro = (p) => ["--ro-bind", p, p];
  return [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--bind", home, home, "--tmpfs", base, ...ro(path.join(base, "engines")), ...ro(app), ...visible.flatMap(ro),
    "--tmpfs", path.dirname(workspace), "--bind", workspace, workspace,
    ...TASK_FILES.map((f) => path.join(workspace, f)).filter((f) => exists(f)).flatMap(ro),
    "--unshare-pid", "--die-with-parent",
  ];
}

/** The bwrap that works here (the release's own first), or null. */
function sandboxTool() {
  for (const bwrap of [path.join(APP, "vendor", "bin", "bwrap"), ...(process.env.PATH ?? "").split(":").map((d) => path.join(d, "bwrap"))]) {
    if (!fs.existsSync(bwrap)) continue;
    const probe = spawnSync(bwrap, ["--ro-bind", "/", "/", "--unshare-pid", "true"], { encoding: "utf8", timeout: 10_000 });
    if (probe.status === 0) return { bwrap };
    return { error: (probe.stderr || probe.error?.message || `exit ${probe.status}`).trim().slice(0, 200) };
  }
  return { error: "no bwrap" };
}

/**
 * The processes to keep running for this task's policy. In user mode every process runs as the
 * caller (`user` null), the server gets the config itself rather than a path, and Codex gets
 * its configuration as arguments.
 */
export function services({ policy, engineEnv, codexArgs = [], userMode = USER_MODE, sandbox = null, env = process.env, password = crypto.randomBytes(24).toString("base64url"), hostToken = crypto.randomBytes(24).toString("base64url") }) {
  const proxy = Object.fromEntries(PROXY_ENV.filter((k) => env[k]).map((k) => [k, env[k]]));
  const SESSION = userMode ? null : SESSION_USER;
  const list = [];
  const serverEnv = {
    PORT: "3000",
    IS_PRODUCTION: "true",
    POLICY_PATH: POLICY,
    EVENTS_DIR,
    DIST_DIR: path.join(APP, "dist"),
    AGENTS_DIR: path.join(APP, "dist-agents"),
    WORKSPACE,
    ...(userMode ? { POLICY_JSON: JSON.stringify(policy) } : {}),
  };
  if (policy.agents.includes("opencosmo")) {
    Object.assign(serverEnv, { OPENCODE_URL: `http://127.0.0.1:${OPENCODE_PORT}`, OPENCODE_SERVER_PASSWORD: password });
    list.push({
      name: "opencode",
      user: SESSION,
      cmd: which("opencode"),
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(OPENCODE_PORT)],
      cwd: WORKSPACE,
      env: { ...engineEnv.opencode, ...proxy, OPENCODE_SERVER_PASSWORD: password },
      port: OPENCODE_PORT,
      // OpenCode treats a folder without git as rooted at /, which the gateway refuses.
      prepare: gitWorkspace,
    });
  }
  if (policy.agents.includes("cosmodex")) {
    serverEnv.CODEX_URL = `ws://127.0.0.1:${CODEX_PORT}`;
    list.push({
      name: "codex",
      user: SESSION,
      cmd: which("codex"),
      // Loopback only. The policy itself comes from /etc/codex/requirements.toml.
      args: ["app-server", ...codexArgs, "--listen", `ws://127.0.0.1:${CODEX_PORT}`],
      cwd: WORKSPACE,
      env: { ...engineEnv.codex, ...proxy },
      port: CODEX_PORT,
    });
  }
  if (policy.agents.includes("cosmo-code")) {
    serverEnv.CLAUDE_HOST_URL = `ws://127.0.0.1:${CLAUDE_PORT}/?token=${hostToken}`;
    list.push({
      name: "claude",
      user: SESSION,
      // The engine host (Agent SDK) drives the pinned engine; the policy itself comes from
      // /etc/claude-code/managed-settings.json, which the engine enforces.
      cmd: process.execPath,
      args: [path.join(APP, "engines", "claude-host", "host.mjs")],
      cwd: WORKSPACE,
      env: {
        ...engineEnv.claude,
        ...proxy,
        COSMO_CODE_PORT: String(CLAUDE_PORT),
        COSMO_CODE_TOKEN: hostToken,
        COSMO_CODE_TERMINAL: policy.terminal,
        WORKSPACE,
        CLAUDE_BIN: which("claude"),
        ...(userMode ? { TERMINAL_SHELL: path.join(APP, "bin", "terminal-shell") } : {}),
      },
      port: CLAUDE_PORT,
      // The Changes pane needs a git repository, as in the original.
      prepare: gitWorkspace,
    });
  }
  // In user mode each engine runs in its own view (engineView) when bwrap works here.
  if (sandbox) {
    for (const svc of list) {
      svc.args = [...sandbox.view, "--", svc.cmd, ...svc.args];
      svc.cmd = sandbox.bwrap;
    }
  }
  list.unshift({ name: "server", user: userMode ? null : "agentsim", cmd: process.execPath, args: [path.join(APP, "server", "index.mjs")], env: serverEnv, port: 3000 });
  return list;
}

function start(svc) {
  // In user mode (no `user`) the process runs as the caller, with the caller's PATH (where npm
  // put the engines) and the release's own tools (bwrap) first.
  const acct = svc.user ? account(svc.user) : { home: os.homedir() };
  const ids = svc.user ? { uid: acct.uid, gid: acct.gid } : {};
  const PATH = svc.user ? "/usr/local/bin:/usr/bin:/bin" : [path.join(APP, "vendor", "bin"), process.env.PATH].join(":");
  try {
    svc.prepare?.();
  } catch (e) {
    log("prepare-failed", { service: svc.name, error: e.message });
  }
  const out = fs.openSync(`${LOG_DIR}/${svc.name}.log`, "a");
  const child = spawn(svc.cmd, svc.args, {
    ...ids,
    cwd: svc.cwd || acct.home,
    env: { PATH, HOME: acct.home, USER: svc.user ?? os.userInfo().username, LANG: "C.UTF-8", ...svc.env },
    stdio: ["ignore", out, out],
    detached: true, // own process group, so a restart takes its children down too
  });
  fs.closeSync(out);
  svc.child = child;
  svc.startedAt = Date.now();
  log("start", { service: svc.name, pid: child.pid });
  child.on("exit", (code, signal) => {
    log("exit", { service: svc.name, pid: child.pid, code, signal });
    svc.child = null;
    checkPorts([svc]); // a crash right after start is often a taken port
    const ranFor = Date.now() - svc.startedAt;
    svc.backoff = ranFor > 30_000 ? 1000 : Math.min((svc.backoff || 500) * 2, MAX_BACKOFF_MS);
    setTimeout(() => start(svc), svc.backoff);
  });
}

// Any listener on a supervised port that is not our child (or its descendant) is an impostor,
// including while our child is down: that is exactly when one can grab the port.
function checkPorts(list) {
  for (const svc of list) {
    if (!svc.port) continue;
    const owner = svc.child?.pid;
    const ownerUid = svc.user ? account(svc.user).uid : process.getuid();
    for (const { inode, uid } of listeningSockets(readTables(), svc.port)) {
      for (const pid of socketOwners(inode, uid)) {
        if (owner && uid === ownerUid && descendsFrom(pid, owner)) continue;
        log("tamper", { service: svc.name, port: svc.port, impostor: pid, uid });
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }
}

function run() {
  if (USER_MODE) return supervise(applyAsUser());
  if (process.getuid() !== 0) throw new Error("the supervisor must run as root");
  if (!fs.existsSync(MARKER) || !fs.existsSync(POLICY)) throw new Error("no applied policy; run apply-policy first");
  for (const dir of [RUN_DIR, LOG_DIR, STATE_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const sim = account("agentsim");
  fs.mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o755 });
  fs.chownSync(EVENTS_DIR, sim.uid, sim.gid);
  const policy = JSON.parse(fs.readFileSync(POLICY, "utf8"));
  const engineEnv = JSON.parse(fs.readFileSync(ENGINE_ENV, "utf8"));
  supervise(services({ policy, engineEnv }));
}

/** User mode: validate the task config once and render every engine's policy into memory. */
function applyAsUser() {
  const file = argValue("--config");
  if (!file) throw new Error("--user needs --config <agent-sim.json>");
  const result = validateTaskConfig(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!result.ok) throw new Error(`invalid ${file}: ${result.errors.join("; ")}`);
  const policy = result.config;
  for (const dir of [RUN_DIR, LOG_DIR, EVENTS_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const catalogPath = `${STATE_DIR}/codex-models.json`;
  const codexBundledCatalog = policy.agents.includes("cosmodex") ? bundledCodexCatalog() : undefined;
  let rendered;
  try {
    rendered = renderUserPolicy(policy, process.env, { codexBundledCatalog }, { catalogPath });
  } catch (e) {
    throw e instanceof RenderError ? new Error(e.errors.join("; ")) : e;
  }
  if (rendered.codexCatalog) fs.writeFileSync(catalogPath, JSON.stringify(rendered.codexCatalog, null, 2) + "\n");
  fs.writeFileSync(POLICY, JSON.stringify(policy, null, 2) + "\n");
  log("applied", { mode: "user", agents: policy.agents });
  const tool = sandboxTool();
  log("sandbox", tool.bwrap ? { state: "on" } : { state: "off", error: tool.error });
  const sandbox = tool.bwrap ? { bwrap: tool.bwrap, view: engineView({ visible: rendered.codexCatalog ? [catalogPath] : [] }) } : null;
  return services({ policy, engineEnv: rendered.engineEnv, codexArgs: rendered.codexArgs, sandbox });
}

function supervise(list) {
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  list.forEach(start);
  setInterval(() => checkPorts(list), CHECK_MS);
  const stop = () => {
    for (const svc of list) if (svc.child) try { process.kill(-svc.child.pid, "SIGTERM"); } catch { /* gone */ }
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function daemonize() {
  // Report a broken task config to the caller (setup) rather than only to the log.
  if (USER_MODE) {
    const result = validateTaskConfig(JSON.parse(fs.readFileSync(argValue("--config") ?? "", "utf8")));
    if (!result.ok) throw new Error(`invalid task config: ${result.errors.join("; ")}`);
  }
  const pid = Number(fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, "utf8") : 0);
  if (pid && alive(pid)) {
    console.log(`supervisor already running (pid ${pid})`);
    return;
  }
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
  const out = fs.openSync(`${LOG_DIR}/supervisor.log`, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter((a) => a !== "--daemon")], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  console.log(`supervisor started (pid ${child.pid})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--daemon")) daemonize();
  else run();
}
