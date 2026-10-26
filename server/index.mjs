// The simulation server on :3000. Serves the shell and the agent UIs, exposes the session API,
// and routes /engine/<agent>/* through that engine's gateway. Runs as its own user under the
// root supervisor, so the agent (running as the session user) can neither kill nor replace it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEventLog } from "./events.mjs";
import { PINS, engineOf, validateTaskConfig } from "../policy/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.IS_PRODUCTION === "true";
const PORT = Number(process.env.PORT || (isProduction ? 3000 : 3001));
const DIST_DIR = process.env.DIST_DIR || path.join(HERE, "..", "dist");
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

function serveStatic(res, pathname) {
  const rel = (pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
  const file = path.resolve(DIST_DIR, rel);
  if (path.relative(path.resolve(DIST_DIR), file).startsWith("..")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

/**
 * @param policy   the applied task config (/etc/agentsim/policy.json)
 * @param gateways map agent -> handler(req, res, subpath); agents without one answer 503
 */
export function createServer({ policy, events, gateways = {} }) {
  const state = { active: policy.default };
  events.record("session-start", { agents: policy.agents, active: state.active, allowSwitch: policy.allowSwitch });

  const session = () => ({
    agents: policy.agents.map((id) => ({
      id,
      label: LABELS[id],
      engine: engineOf(id, PINS),
      available: Boolean(gateways[id]),
      models: policy.models[id],
    })),
    active: state.active,
    allowSwitch: policy.allowSwitch,
    terminal: policy.terminal,
  });

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    try {
      if (pathname === "/api/health") return sendJson(res, 200, { ok: true });
      if (pathname === "/api/session" && req.method === "GET") return sendJson(res, 200, session());
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
      if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
      if (!isProduction) return sendJson(res, 404, { error: "development mode: the UI is served by Vite (npm run start:dev)" });
      return serveStatic(res, pathname);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The applied policy is already normalized; validating again also lets development point
  // POLICY_PATH at a hand-written agent-sim.json.
  let policy;
  try {
    const result = validateTaskConfig(JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")));
    if (!result.ok) throw new Error(result.errors.join("; "));
    policy = result.config;
  } catch (e) {
    console.error(`cannot load the policy at ${POLICY_PATH}: ${e.message}`);
    process.exit(1);
  }
  const events = createEventLog(process.env.EVENTS_DIR);
  createServer({ policy, events }).listen(PORT, () => console.log(`agentsim server on :${PORT}`));
}
