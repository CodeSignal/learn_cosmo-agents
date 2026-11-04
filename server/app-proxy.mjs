// The candidate's own web app (task setting "app"): the preview on :3000 stays the simulation's,
// and every path outside its own (/ and /_cosmo/…) goes to the app's dev server on loopback, for
// the shell's App pane. The app serves under APP_PATH (Vite `base`); absolute paths its code uses
// without that base (fetch("/data/lots.json")) are sent there too.
import http from "node:http";

/** Where the simulation's own routes live once a task has an app. */
export const COSMO = "/_cosmo";

/** The app's path for a request path: under the app's base already, or moved under it. */
export function appTarget(pathAndQuery, base) {
  const root = base.replace(/\/$/, "");
  return pathAndQuery === root || pathAndQuery.startsWith(root + "/") || pathAndQuery.startsWith(root + "?") ? pathAndQuery : root + pathAndQuery;
}

// The dev server sees a loopback request, as from the candidate's own browser: Vite refuses other
// hosts and origins. A service worker can't claim more than the app's base, so it can't take over
// the simulation's pages.
function upstreamHeaders(req, port) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  if (headers.origin && headers.origin !== "null") headers.origin = `http://127.0.0.1:${port}`;
  for (const h of ["connection", "keep-alive", "proxy-authorization", "te", "trailer", "upgrade"]) delete headers[h];
  return headers;
}

function notRunning(req, res, { port, base }) {
  const page = (req.headers.accept ?? "").includes("text/html");
  res.writeHead(502, { "content-type": page ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store" });
  if (!page) return res.end(JSON.stringify({ error: `nothing is listening on port ${port}` }));
  res.end(`<!doctype html><meta charset="utf-8"><title>App not running</title>
<style>body{font:15px/1.5 system-ui,sans-serif;color:#555;display:grid;place-items:center;height:100vh;margin:0}p{max-width:28em;text-align:center}code{background:#f2f2f2;padding:1px 4px;border-radius:4px}</style>
<p>Nothing is running on port <code>${port}</code> yet. Start the app's development server (for example <code>npm run dev</code>), then reload. It is shown at <code>${base}</code>.</p>`);
}

export function proxyApp(req, res, { port, path: base }) {
  // No pooled connections: the dev server restarts often, and a kept-alive socket would outlive it.
  const up = http.request({ host: "127.0.0.1", port, method: req.method, path: appTarget(req.url, base), headers: upstreamHeaders(req, port), agent: false }, (r) => {
    const headers = { ...r.headers };
    delete headers["service-worker-allowed"];
    res.writeHead(r.statusCode || 502, headers);
    r.pipe(res);
  });
  up.on("error", () => (res.headersSent ? res.end() : notRunning(req, res, { port, base })));
  req.pipe(up);
  res.on("close", () => up.destroy());
}

/** WebSocket upgrades (the dev server's hot reload). */
export function proxyAppUpgrade(req, socket, head, { port, path: base }) {
  const up = http.request({ host: "127.0.0.1", port, path: appTarget(req.url, base), headers: { ...upstreamHeaders(req, port), connection: "Upgrade", upgrade: req.headers.upgrade }, agent: false });
  up.on("upgrade", (r, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`];
    for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
  });
  up.on("response", (r) => socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`));
  up.on("error", () => socket.destroy());
  up.end();
}
