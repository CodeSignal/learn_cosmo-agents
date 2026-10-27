// Root supervisor. Starts the simulation's processes under their own users, restarts any that
// die, and kills a process that takes over a supervised port (an agent can kill an engine it
// owns and start its own copy without the lockdown; this undoes that and logs it).
//
//   supervisor.mjs --daemon   detach and run in the background (what agentsim-start calls)
//   supervisor.mjs            run in the foreground
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listeningSockets, readTables, pidsForInodes, uidOf, descendsFrom } from "./procnet.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_DIR = "/run/agentsim";
const PID_FILE = `${RUN_DIR}/supervisor.pid`;
const LOG_DIR = "/var/log/agentsim";
const STATE_DIR = "/var/lib/agentsim";
const EVENTS_DIR = `${STATE_DIR}/events`;
const POLICY = "/etc/agentsim/policy.json";
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
  if (!pids.length && uid !== 0) {
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
  for (const dir of ["/usr/local/bin", "/usr/bin", "/bin"]) {
    if (fs.existsSync(path.join(dir, bin))) return path.join(dir, bin);
  }
  throw new Error(`${bin} is not installed`);
}

/**
 * The workspace as a git repository (engines show changes against it), with the task's own
 * files (.codesignal) in the repo-local exclude list, so they stay out of change lists and file
 * search (cosmetic: the agent can still read them).
 */
function gitWorkspace() {
  const acct = account(SESSION_USER);
  const script = [
    "[ -d .git ] || git init -q",
    'f=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$f")"',
    'grep -qxF ".codesignal/" "$f" 2>/dev/null || echo ".codesignal/" >> "$f"',
  ].join(" && ");
  spawnSync("sh", ["-c", script], { cwd: WORKSPACE, uid: acct.uid, gid: acct.gid, env: { PATH: "/usr/bin:/bin", HOME: acct.home } });
}

/** The processes to keep running for this task's policy. */
export function services({ policy, engineEnv, env = process.env, password = crypto.randomBytes(24).toString("base64url"), hostToken = crypto.randomBytes(24).toString("base64url") }) {
  const proxy = Object.fromEntries(PROXY_ENV.filter((k) => env[k]).map((k) => [k, env[k]]));
  const list = [];
  const serverEnv = {
    PORT: "3000",
    IS_PRODUCTION: "true",
    POLICY_PATH: POLICY,
    EVENTS_DIR,
    DIST_DIR: path.join(APP, "dist"),
    AGENTS_DIR: path.join(APP, "dist-agents"),
    WORKSPACE,
  };
  if (policy.agents.includes("opencosmo")) {
    Object.assign(serverEnv, { OPENCODE_URL: `http://127.0.0.1:${OPENCODE_PORT}`, OPENCODE_SERVER_PASSWORD: password });
    list.push({
      name: "opencode",
      user: SESSION_USER,
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
      user: SESSION_USER,
      cmd: which("codex"),
      // Loopback only. The policy itself comes from /etc/codex/requirements.toml.
      args: ["app-server", "--listen", `ws://127.0.0.1:${CODEX_PORT}`],
      cwd: WORKSPACE,
      env: { ...engineEnv.codex, ...proxy },
      port: CODEX_PORT,
    });
  }
  if (policy.agents.includes("cosmo-code")) {
    serverEnv.CLAUDE_HOST_URL = `ws://127.0.0.1:${CLAUDE_PORT}/?token=${hostToken}`;
    list.push({
      name: "claude",
      user: SESSION_USER,
      // The engine host (Agent SDK) drives the pinned engine; the policy itself comes from
      // /etc/claude-code/managed-settings.json, which the engine enforces.
      cmd: process.execPath,
      args: [path.join(APP, "engines", "claude-host", "host.mjs")],
      cwd: WORKSPACE,
      env: { ...engineEnv.claude, ...proxy, COSMO_CODE_PORT: String(CLAUDE_PORT), COSMO_CODE_TOKEN: hostToken, WORKSPACE, CLAUDE_BIN: which("claude") },
      port: CLAUDE_PORT,
      // The Changes pane needs a git repository, as in the original.
      prepare: gitWorkspace,
    });
  }
  list.unshift({ name: "server", user: "agentsim", cmd: process.execPath, args: [path.join(APP, "server", "index.mjs")], env: serverEnv, port: 3000 });
  return list;
}

function start(svc) {
  const acct = account(svc.user);
  try {
    svc.prepare?.();
  } catch (e) {
    log("prepare-failed", { service: svc.name, error: e.message });
  }
  const out = fs.openSync(`${LOG_DIR}/${svc.name}.log`, "a");
  const child = spawn(svc.cmd, svc.args, {
    uid: acct.uid,
    gid: acct.gid,
    cwd: svc.cwd || acct.home,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: acct.home, USER: svc.user, LANG: "C.UTF-8", ...svc.env },
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
    const ownerUid = account(svc.user).uid;
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
  if (process.getuid() !== 0) throw new Error("the supervisor must run as root");
  if (!fs.existsSync(MARKER) || !fs.existsSync(POLICY)) throw new Error("no applied policy; run apply-policy first");
  for (const dir of [RUN_DIR, LOG_DIR, STATE_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const sim = account("agentsim");
  fs.mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o755 });
  fs.chownSync(EVENTS_DIR, sim.uid, sim.gid);
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  const policy = JSON.parse(fs.readFileSync(POLICY, "utf8"));
  const engineEnv = JSON.parse(fs.readFileSync(ENGINE_ENV, "utf8"));
  const list = services({ policy, engineEnv });
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
  const pid = Number(fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, "utf8") : 0);
  if (pid && alive(pid)) {
    console.log(`supervisor already running (pid ${pid})`);
    return;
  }
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
  const out = fs.openSync(`${LOG_DIR}/supervisor.log`, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
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
