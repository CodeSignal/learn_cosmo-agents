// Run inside the test container as the session user: drives the Cosmo Code gateway against the
// engine host and the pinned Claude Code engine, and prints one "PASS|FAIL <id> <description>"
// line per check.
const G = "http://localhost:3000/engine/cosmo-code";
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
const ready = await ev.waitFor((m) => m.method === "cosmo-code/engine" && m.params?.state === "ready", 60000);
report("C1", "the gateway reaches the engine host (token-protected) and initializes it", !!ready, JSON.stringify(ev.seen.slice(-2)));

const direct = await new Promise((resolve) => {
  const ws = new WebSocket("ws://127.0.0.1:4600/");
  ws.onopen = () => (ws.close(), resolve("open"));
  ws.onerror = () => resolve("refused");
});
report("C2", "the engine host refuses connections without the gateway's token", direct === "refused", direct);

const init = await rpc("initialize", {});
const resolved = (init.body.result?.models ?? []).map((m) => m.resolvedModel ?? m.value);
report("C3", "the engine offers only the task's models",
  resolved.length > 0 && resolved.every((m) => m === "claude-sonnet-5-5") && (init.body.result?.commands ?? []).length > 0, JSON.stringify(init.body).slice(0, 300));

const opus = await rpc("session/send", { text: "hi", model: "claude-opus-5-5" });
const bypass = await rpc("session/send", { text: "hi", permissionMode: "bypassPermissions" });
const setup = await rpc("session/send", { text: "hi", cwd: "/" });
const del = await rpc("session/delete", { sessionId: "6a65de5f-2584-4484-a240-6ac4b43731f0" });
const unknown = await rpc("engine/everything", {});
report("C4", "a model or mode the task doesn't allow, engine setup and deleting transcripts are refused; unknown methods are not found",
  [opus, bypass, setup, del].every((r) => r.status === 403 && r.body.error?.data?.blocked) && unknown.status === 404,
  JSON.stringify([opus.status, bypass.status, setup.status, del.status, unknown.status]));

// A command needs the candidate's approval (the task's ask rules; sandboxed commands aren't
// approved silently).
const sent = await rpc("session/send", { text: "RUN: echo approved > cosmo-code.txt" });
const sid = sent.body.result?.sessionId;
const ask = await ev.waitFor((m) => m.id !== undefined && m.method === "session/permission" && m.params?.sessionId === sid);
report("C5", "the agent's command waits for the candidate's approval (request reaches the browser)", !!sid && ask?.params?.toolName === "Bash", JSON.stringify(ask ?? ev.seen.slice(-3)).slice(0, 300));
if (ask) {
  const forged = await respond(ask.id, { behavior: "allow", alwaysAllow: true, ruleContent: "*" });
  const edited = await respond(ask.id, { behavior: "allow", answers: { q: "a" } });
  const plain = await respond(ask.id, { behavior: "allow" });
  report("C6", "only plain answers pass (a made-up rule or edited input is refused)", forged.status === 403 && edited.status === 403 && plain.status === 200, `${forged.status} ${edited.status} ${plain.status}`);
  const done = await ev.waitFor((m) => m.method === "session/message" && m.params?.sessionId === sid && m.params.message?.type === "result");
  const ran = ev.seen.find((m) => m.method === "session/message" && m.params?.sessionId === sid && JSON.stringify(m.params.message).includes("tool_result"));
  report("C7", "the turn completes after the answer, with the tool's result", !!done && !!ran, JSON.stringify(ev.seen.slice(-2)).slice(0, 300));
}

if (sid) {
  const list = await rpc("session/list", {});
  const read = await rpc("session/read", { sessionId: sid });
  const renamed = await rpc("session/rename", { sessionId: sid, title: "Renamed session" });
  const fork = await rpc("session/fork", { sessionId: sid });
  const archived = await rpc("session/archive", { sessionId: sid });
  const after = await rpc("session/list", {});
  const row = (after.body.result?.sessions ?? []).find((s) => s.sessionId === sid);
  report("C8", "sessions list, read back, rename, fork and archive",
    (list.body.result?.sessions ?? []).some((s) => s.sessionId === sid) && (read.body.result?.messages ?? []).length >= 2 && renamed.status === 200 && !!fork.body.result?.sessionId && archived.status === 200 && row?.archived === true,
    JSON.stringify([read.body.result?.messages?.length, renamed.status, fork.body, archived.status, row]).slice(0, 300));
}

ev.close();
process.exit(failed ? 1 : 0);
