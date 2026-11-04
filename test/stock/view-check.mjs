// Run inside the stand-in container (test/stock/run.sh) as the session user: an agent's command,
// approved, sees only the engine's view (root/supervisor.mjs, engineView). Prints one
// "PASS|FAIL <id> <description>" line per check.
const G = "http://localhost:3000/_cosmo/engine/cosmo-code";
const started = new Date().toISOString();
let failed = 0;

function report(id, desc, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${desc}${ok || !detail ? "" : `\n      ${String(detail).slice(0, 300)}`}`);
}

async function rpc(method, params) {
  const res = await fetch(`${G}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  return { status: res.status, body: await res.json() };
}

const respond = (id, result) => fetch(`${G}/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: String(id), result }) });

/** Collect SSE messages; `waitFor(pred, ms)` resolves with the first match. */
function events() {
  const seen = [];
  const waiters = [];
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${G}/events`, { signal: ctrl.signal });
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
        buf = buf.slice(i + 2);
        if (!data) continue;
        const msg = JSON.parse(data);
        seen.push(msg);
        for (const w of [...waiters]) if (w.pred(msg)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(msg));
      }
    }
  })().catch(() => {});
  return {
    seen,
    close: () => ctrl.abort(),
    waitFor(pred, ms = 30000) {
      const hit = seen.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => (waiters.splice(waiters.indexOf(w), 1), resolve(null)), ms);
      });
    },
  };
}

const ev = events();
await ev.waitFor((m) => m.method === "cosmo-code/engine" && m.params?.state === "ready", 60000);

const probe = [
  "for p in ~/.cosmo-agents/state/policy.json ~/.cosmo-agents/log /usercode/.env; do test -e $p && echo SEEN:$p; done",
  "echo x >> main.sh 2>/dev/null && echo WROTE:main.sh",
  "echo x > .codesignal/x 2>/dev/null && echo WROTE:codesignal",
  "echo ok > view-ok.txt && echo WROTE:workspace",
  "echo END",
].join("; ");
const sent = await rpc("session/send", { text: `RUN: ${probe}` });
const sid = sent.body.result?.sessionId;
const ask = await ev.waitFor((m) => m.id !== undefined && m.method === "session/permission" && m.params?.sessionId === sid);
if (ask) await respond(ask.id, { behavior: "allow" });
await ev.waitFor((m) => m.method === "session/message" && m.params?.sessionId === sid && m.params.message?.type === "result", 60000);
const out = ev.seen
  .filter((m) => m.method === "session/message" && m.params?.sessionId === sid)
  .flatMap((m) => (Array.isArray(m.params.message?.message?.content) ? m.params.message.message.content : []))
  .filter((c) => c.type === "tool_result")
  .map((c) => (typeof c.content === "string" ? c.content : JSON.stringify(c.content)))
  .join("\n");
const ran = out.includes("END");
report("V1", "the agent can't see the simulation's records and logs, or the rest of /usercode", ran && !out.includes("SEEN:/"), out.slice(0, 300));
report("V2", "the agent can't change main.sh or .codesignal", ran && !out.includes("WROTE:main.sh") && !out.includes("WROTE:codesignal"), out.slice(0, 300));
report("V3", "the agent still writes to the workspace", ran && out.includes("WROTE:workspace"), out.slice(0, 300));
ev.close();
process.exit(failed ? 1 : 0);
