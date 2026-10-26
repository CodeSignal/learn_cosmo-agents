// The browser never talks to an engine directly. Each engine's gateway sits in between,
// passes only allowlisted requests, and records everything it refuses.
import http from "node:http";

/**
 * A request rule: `method` ("*" for any) and `path` (RegExp tested against the path without
 * the query). The first matching rule decides; no match means blocked.
 */
export class RouteGateway {
  constructor({ name, rules, events }) {
    this.name = name;
    this.rules = rules;
    this.events = events;
  }

  decide(method, pathname) {
    for (const rule of this.rules) {
      if ((rule.method === "*" || rule.method === method) && rule.path.test(pathname)) {
        return { allow: rule.allow !== false, reason: rule.reason };
      }
    }
    return { allow: false, reason: "not on the allowlist" };
  }

  /** Answer a refused request the way the UIs expect, and log it. */
  block(res, { method, pathname, reason, agent }) {
    this.events?.record("blocked", { gateway: this.name, agent, method, path: pathname, reason });
    res.writeHead(403, { "content-type": "application/json", "x-agentsim-blocked": "1" });
    res.end(JSON.stringify({ blocked: true, reason: reason || "Blocked by the simulation" }));
  }
}

/**
 * Forward one HTTP request to `target` (http://host:port), streaming both ways so SSE and
 * long responses pass through untouched. `headers` are added or overridden upstream (e.g. the
 * engine's auth), and hop-by-hop headers are dropped.
 */
export function proxyHttp(req, res, { target, path, headers = {} }) {
  const url = new URL(path, target);
  const forward = { ...req.headers, ...headers, host: url.host };
  for (const h of ["connection", "keep-alive", "proxy-authorization", "te", "trailer", "upgrade"]) delete forward[h];
  const upstream = http.request(url, { method: req.method, headers: forward }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `engine unavailable: ${e.code || e.message}` }));
  });
  req.pipe(upstream);
  res.on("close", () => upstream.destroy());
}
