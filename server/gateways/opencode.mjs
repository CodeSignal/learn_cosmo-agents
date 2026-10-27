// OpenCosmo's gateway to `opencode serve` on loopback: allowlisted routes only, every folder
// clamped to the task workspace, the engine's password injected so the browser never sees it.
import { RouteGateway, proxyHttp, proxyUpgrade } from "../gateway.mjs";
import { ROUTES, pathPattern } from "./opencode-routes.mjs";

const TERMINAL_REASON = "the terminal";

export function createOpenCodeGateway({ target, password, workspace, terminal, events, agent = "opencosmo" }) {
  const rules = ROUTES.map(([method, path, decision]) => ({
    method,
    path: pathPattern(path),
    allow: decision === "allow" || (decision === "terminal" && terminal),
    reason: decision === "terminal" ? TERMINAL_REASON : decision,
  }));
  const gateway = new RouteGateway({ name: "opencode", rules, events });
  const auth = password ? { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") } : {};
  const root = workspace.replace(/\/+$/, "");

  // Folders arrive as ?directory= and the x-opencode-directory header.
  const outside = (req, url) =>
    [url.searchParams.get("directory"), req.headers["x-opencode-directory"]]
      .filter(Boolean)
      .map((d) => {
        try {
          return decodeURIComponent(d);
        } catch {
          return d;
        }
      })
      .some((d) => d !== root && !d.startsWith(root + "/"));

  const check = (req, method, sub) => {
    const url = new URL(sub, "http://engine");
    const verdict = gateway.decide(method, url.pathname);
    if (!verdict.allow) return { pathname: url.pathname, reason: verdict.reason, unknown: verdict.unknown };
    // The folder pickers list the home folder by themselves; reads outside the workspace are
    // refused without an event, changes are refused and logged.
    if (outside(req, url)) return { pathname: url.pathname, reason: "folders outside the task's workspace", quiet: method === "GET" };
    return null;
  };

  // OpenCode's own error shape, so the UI shows the refusal as a normal toast.
  gateway.blockBody = (reason) => ({ name: "Forbidden", data: { message: `Blocked by the simulation: ${reason} can't be changed here.` } });

  const handler = (req, res, sub) => {
    const refused = check(req, req.method, sub);
    if (refused?.unknown) return gateway.notFound(res, { method: req.method, pathname: refused.pathname });
    if (refused) return gateway.block(res, { method: req.method, agent, ...refused });
    proxyHttp(req, res, { target, path: sub, headers: auth });
  };
  handler.upgrade = (req, socket, head, sub) => {
    const refused = check(req, "GET", sub);
    if (refused) {
      events?.record("blocked", { gateway: "opencode", agent, method: "UPGRADE", path: refused.pathname, reason: refused.reason });
      return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
    proxyUpgrade(req, socket, head, { target, path: sub, headers: auth });
  };
  return handler;
}
