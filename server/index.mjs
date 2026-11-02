// The simulation server on :3000. Serves the shell and the agent UIs, exposes the session API,
// routes /engine/<agent>/* through that engine's gateway, and serves workspace files for an agent
// UI's preview. Runs as its own user under the root supervisor, so the agent (running as the
// session user) can neither kill nor replace it.
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEventLog } from "./events.mjs";
import { createOpenCodeGateway } from "./gateways/opencode.mjs";
import { createCodexGateway } from "./gateways/codex.mjs";
import { createClaudeGateway } from "./gateways/claude.mjs";
import { claudeCeilings, codexCeilings } from "../policy/render.mjs";
import { workspaceDiff, SCOPES } from "./workspace-git.mjs";
import { PINS, engineOf, validateTaskConfig } from "../policy/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.IS_PRODUCTION === "true";
const PORT = Number(process.env.PORT || (isProduction ? 3000 : 3001));
const DIST_DIR = process.env.DIST_DIR || path.join(HERE, "..", "dist");
const AGENTS_DIR = process.env.AGENTS_DIR || path.join(HERE, "..", "dist-agents");
const POLICY_PATH = process.env.POLICY_PATH || "/etc/agentsim/policy.json";

export const LABELS = { opencosmo: "OpenCosmo", cosmodex: "Cosmodex", "cosmo-code": "Cosmo Code" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    const headers = { "content-type": MIME[path.extname(file)] || "application/octet-stream" };
    // Pages must pick up a new build; hashed assets may be cached.
    if (path.extname(file) === ".html") headers["cache-control"] = "no-cache";
    res.writeHead(200, headers);
    res.end(data);
  });
}

/**
 * Whether a request comes from another site or from a sandboxed frame (such as a preview of a
 * file the agent wrote, whose origin is "null"). Requests that change something, and WebSocket
 * upgrades, must come from the app's own pages: browsers mark the others (Sec-Fetch-Site, Origin);
 * clients outside a browser (the tests, curl) send neither.
 */
export function crossSite(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return true;
  return req.headers.origin === "null";
}

// What the preview serves, by extension, under /api/workspace/preview/<token>/. Pages run sandboxed
// (an opaque origin) with no network: they can load other workspace files, but can't call the app's
// APIs or reach other sites. Being sandboxed, their own files are cross-origin to them, so the
// files can't be marked same-origin only; the token (given out by /api/session, which other sites
// can't read) keeps other sites from loading workspace files, scripts included.
const PREVIEW = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
const PREVIEW_MAX = 25 * 1024 * 1024;
const PREVIEW_CSP =
  "sandbox allow-scripts allow-forms allow-modals; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  "connect-src 'none'; form-action 'none'; frame-src 'self'; base-uri 'none'; object-src 'none'";
// Folders the preview never serves (the repository's internals and the task's own files).
const PREVIEW_HIDDEN = new Set([".git", ".codesignal"]);

/** A workspace file for the preview: inside the workspace after links are followed, a regular file
 * of a type the preview shows, not under a hidden folder. */
async function servePreview(res, workspace, rel) {
  const refuse = (status, text) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };
  let parts;
  try {
    parts = rel.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return refuse(400, "Bad path");
  }
  if (!parts.length || parts.some((p) => p === ".." || p === "." || p.includes("/") || p.includes("\\") || PREVIEW_HIDDEN.has(p))) return refuse(404, "Not found");
  const type = PREVIEW[path.extname(parts.at(-1)).toLowerCase()];
  if (!type) return refuse(415, "This kind of file can't be previewed.");
  let file;
  try {
    const root = await fs.promises.realpath(workspace);
    file = await fs.promises.realpath(path.join(root, ...parts));
    if (path.relative(root, file).startsWith("..") || path.relative(root, file).split(path.sep).some((p) => PREVIEW_HIDDEN.has(p))) return refuse(404, "Not found");
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return refuse(404, "Not found");
    if (st.size > PREVIEW_MAX) return refuse(413, "This file is too large to preview.");
  } catch {
    return refuse(404, "Not found");
  }
  const headers = {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "cross-origin",
  };
  // PDFs open in the browser's own viewer, which a sandbox would disable; they run no page script.
  if (type !== "application/pdf") headers["content-security-policy"] = PREVIEW_CSP;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

/** A file under `root`, or null when the path would leave it. */
function within(root, rel) {
  const file = path.resolve(root, rel.replace(/^\/+/, ""));
  return path.relative(path.resolve(root), file).startsWith("..") ? null : file;
}

function serveStatic(res, pathname) {
  const file = within(DIST_DIR, pathname === "/" ? "/index.html" : pathname);
  if (!file) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  sendFile(res, file);
}

/** An agent UI under /agents/<agent>/: its files, or its index.html for client-side routes. */
function serveAgent(res, agent, rest) {
  const root = path.join(AGENTS_DIR, agent);
  const file = within(root, rest || "/");
  if (!file) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.stat(file, (err, st) => sendFile(res, !err && st.isFile() ? file : path.join(root, "index.html")));
}

/**
 * @param policy   the applied task config (/etc/agentsim/policy.json)
 * @param gateways map agent -> handler(req, res, subpath); agents without one answer 503
 */
export function createServer({ policy, events, gateways = {}, workspace = process.env.WORKSPACE || "/usercode/FILESYSTEM" }) {
  const previewBase = `/api/workspace/preview/${crypto.randomBytes(16).toString("hex")}/`;
  const state = { active: policy.default };
  events.record("session-start", { agents: policy.agents, active: state.active, allowSwitch: policy.allowSwitch });

  const session = () => ({
    agents: policy.agents.map((id) => ({
      id,
      label: LABELS[id],
      engine: engineOf(id, PINS),
      // Usable once its engine gateway exists and its UI has been built.
      available: Boolean(gateways[id]) && fs.existsSync(path.join(AGENTS_DIR, id, "index.html")),
      models: policy.models[id],
    })),
    active: state.active,
    allowSwitch: policy.allowSwitch,
    terminal: policy.terminal,
    sandbox: policy.sandbox,
    autoMode: policy.permissions.auto,
    preview: previewBase,
  });

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && crossSite(req)) {
        events.record("blocked", { gateway: "shell", action: "cross-site request", method: req.method, path: pathname });
        return sendJson(res, 403, { blocked: true, reason: "Requests from other sites or sandboxed pages are refused." });
      }
      if (pathname === "/api/health") return sendJson(res, 200, { ok: true });
      if (pathname === "/api/session" && req.method === "GET") return sendJson(res, 200, session());
      if (pathname === "/api/workspace/diff" && req.method === "GET") {
        const scope = new URL(req.url, "http://localhost").searchParams.get("scope");
        if (!SCOPES.includes(scope)) return sendJson(res, 400, { error: `scope must be one of: ${SCOPES.join(", ")}` });
        return sendJson(res, 200, await workspaceDiff(workspace, scope));
      }
      if (pathname.startsWith(previewBase) && (req.method === "GET" || req.method === "HEAD")) {
        return servePreview(res, workspace, pathname.slice(previewBase.length));
      }
      if (pathname === "/api/switch" && req.method === "POST") {
        let agent;
        try {
          agent = JSON.parse(await readBody(req)).agent;
        } catch {
          return sendJson(res, 400, { error: "expected {\"agent\": \"...\"}" });
        }
        if (!policy.agents.includes(agent)) {
          events.record("blocked", { gateway: "shell", action: "switch", agent, reason: "agent not enabled for this task" });
          return sendJson(res, 403, { blocked: true, reason: "This agent is not available in this task." });
        }
        if (agent !== state.active && !policy.allowSwitch) {
          events.record("blocked", { gateway: "shell", action: "switch", agent, reason: "switching disabled" });
          return sendJson(res, 403, { blocked: true, reason: "Switching agents is disabled in this task." });
        }
        if (agent !== state.active) events.record("switch", { from: state.active, to: agent });
        state.active = agent;
        return sendJson(res, 200, session());
      }
      const m = /^\/engine\/([a-z-]+)(\/.*)?$/.exec(pathname);
      if (m) {
        const [, agent, sub = "/"] = m;
        if (!policy.agents.includes(agent)) {
          events.record("blocked", { gateway: "shell", action: "engine", agent, path: sub, reason: "agent not enabled for this task" });
          return sendJson(res, 403, { blocked: true, reason: "This agent is not available in this task." });
        }
        const handler = gateways[agent];
        if (!handler) return sendJson(res, 503, { error: `${LABELS[agent]} is not available yet` });
        return handler(req, res, sub + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""));
      }
      const ui = /^\/agents\/([a-z-]+)(\/.*)?$/.exec(pathname);
      if (ui && policy.agents.includes(ui[1]) && gateways[ui[1]]) return serveAgent(res, ui[1], ui[2]);
      if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
      if (!isProduction) return sendJson(res, 404, { error: "development mode: the UI is served by Vite (npm run start:dev)" });
      return serveStatic(res, pathname);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname, search } = new URL(req.url, "http://localhost");
    if (crossSite(req)) {
      events.record("blocked", { gateway: "shell", action: "cross-site request", method: "upgrade", path: pathname });
      return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
    const m = /^\/engine\/([a-z-]+)(\/.*)?$/.exec(pathname);
    const handler = m && policy.agents.includes(m[1]) ? gateways[m[1]] : null;
    if (!handler?.upgrade) return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    handler.upgrade(req, socket, head, (m[2] || "/") + search);
  });
  return server;
}

/** The engine gateways for the task's agents, from the supervisor-provided environment. */
export function gatewaysFor(policy, events, env = process.env) {
  const gateways = {};
  if (policy.agents.includes("opencosmo")) {
    gateways.opencosmo = createOpenCodeGateway({
      target: env.OPENCODE_URL || "http://127.0.0.1:4096",
      password: env.OPENCODE_SERVER_PASSWORD,
      workspace: env.WORKSPACE || "/usercode/FILESYSTEM",
      terminal: policy.terminal === "sandboxed",
      events,
      watch: true,
    });
  }
  if (policy.agents.includes("cosmodex")) {
    gateways.cosmodex = createCodexGateway({
      url: env.CODEX_URL || "ws://127.0.0.1:4500",
      workspace: env.WORKSPACE || "/usercode/FILESYSTEM",
      terminal: policy.terminal === "sandboxed",
      ceilings: codexCeilings(policy),
      events,
    });
  }
  if (policy.agents.includes("cosmo-code") && env.CLAUDE_HOST_URL) {
    gateways["cosmo-code"] = createClaudeGateway({ url: env.CLAUDE_HOST_URL, ceilings: claudeCeilings(policy), terminal: policy.terminal === "sandboxed", events });
  }
  return gateways;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The applied policy is already normalized; validating again also lets development point
  // POLICY_PATH at a hand-written agent-sim.json.
  let policy;
  try {
    // Without root the supervisor passes the config itself (a file the session user could edit).
    const result = validateTaskConfig(JSON.parse(process.env.POLICY_JSON ?? fs.readFileSync(POLICY_PATH, "utf8")));
    if (!result.ok) throw new Error(result.errors.join("; "));
    policy = result.config;
  } catch (e) {
    console.error(`cannot load the policy at ${POLICY_PATH}: ${e.message}`);
    process.exit(1);
  }
  const events = createEventLog(process.env.EVENTS_DIR);
  createServer({ policy, events, gateways: gatewaysFor(policy, events) }).listen(PORT, () => console.log(`agentsim server on :${PORT}`));
}
