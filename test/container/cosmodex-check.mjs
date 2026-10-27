// Run inside the test container as the session user: drives the Cosmodex gateway against the
// real `codex app-server` and prints one "PASS|FAIL <id> <description>" line per check.
const G = "http://localhost:3000/engine/cosmodex";
const WS = "/usercode/FILESYSTEM";
let failed = 0;

function report(id, desc, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${desc}${ok || !detail ? "" : `\n      ${String(detail).slice(0, 300)}`}`);
}

async function rpc(method, params) {
  const res = await fetch(`${G}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  return { status: res.status, body: await res.json() };
}

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
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
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
    waitFor(pred, ms = 20000) {
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
const ready = await ev.waitFor((m) => m.method === "cosmodex/engine" && m.params?.state === "ready", 30000);
report("X1", "the gateway reaches app-server and initializes it", !!ready, JSON.stringify(ev.seen.slice(-2)));

const models = await rpc("model/list", {});
const slugs = (models.body.result?.data ?? models.body.result?.models ?? []).map((m) => m.model ?? m.slug ?? m.id);
report("X2", "model/list offers only the task's models", slugs.length > 0 && slugs.every((s) => ["gpt-5.6-terra", "gpt-6-luna"].includes(s)), JSON.stringify(models.body).slice(0, 300));

const astra = await rpc("thread/start", { model: "gpt-6-astra" });
const danger = await rpc("thread/start", { sandbox: "danger-full-access" });
const never = await rpc("thread/start", { approvalPolicy: "never" });
const cfg = await rpc("thread/start", { config: { model_provider: "evil" } });
report("X3", "a model, sandbox, approval policy or config the task doesn't allow is refused",
  [astra, danger, never, cfg].every((r) => r.status === 403 && r.body.error?.data?.blocked), JSON.stringify([astra, danger, never, cfg].map((r) => r.status)));

const write = await rpc("config/value/write", { keyPath: "model", value: "gpt-6-astra" });
const login = await rpc("account/login/start", { type: "chatgpt" });
const unknown = await rpc("tui/everything", {});
const outside = await rpc("fs/readFile", { path: "/etc/passwd" });
report("X4", "config writes, sign-in and files outside the workspace are refused; unknown methods are not found",
  write.status === 403 && login.status === 403 && outside.status === 403 && unknown.status === 404, JSON.stringify([write.status, login.status, outside.status, unknown.status]));

const started = await rpc("thread/start", { model: "gpt-6-luna" });
const thread = started.body.result?.thread;
report("X5", "a thread starts in the workspace with the task's approval policy and sandbox",
  thread && started.body.result?.cwd === WS && started.body.result?.approvalPolicy === "untrusted" && started.body.result?.model === "gpt-6-luna",
  JSON.stringify(started.body).slice(0, 400));

if (thread) {
  await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "RUN: echo approved > cosmodex.txt", text_elements: [] }] });
  const ask = await ev.waitFor((m) => m.id !== undefined && m.method === "item/commandExecution/requestApproval");
  report("X6", "the agent's command waits for the candidate's approval (request reaches the browser)", !!ask, JSON.stringify(ev.seen.slice(-3)).slice(0, 300));
  if (ask) {
    const sneaky = await fetch(`${G}/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask.id, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } } } }) });
    // The browser sends ids as strings.
    const plain = await fetch(`${G}/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: String(ask.id), result: { decision: "accept" } }) });
    report("X7", "only plain decisions are accepted (a policy amendment is refused)", sneaky.status === 403 && plain.status === 200, `${sneaky.status} ${plain.status}`);
    const done = await ev.waitFor((m) => m.method === "turn/completed");
    report("X8", "the turn completes after the answer", !!done, JSON.stringify(ev.seen.slice(-3)).slice(0, 300));
  }
}

// File edits: an approved ADD creates the file, and the workspace diff (read-only git, run by
// the server's own user) shows it.
const edit = await rpc("thread/start", {});
if (edit.body.result) {
  const tid = edit.body.result.thread.id;
  await rpc("turn/start", { threadId: tid, input: [{ type: "text", text: "ADD: notes/hello.txt hello from cosmodex", text_elements: [] }] });
  const ask = await ev.waitFor((m) => m.id !== undefined && m.method === "item/fileChange/requestApproval" && m.params?.threadId === tid);
  if (ask) await fetch(`${G}/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: String(ask.id), result: { decision: "accept" } }) });
  await ev.waitFor((m) => m.method === "turn/completed" && m.params?.threadId === tid);
  const diff = await (await fetch("http://localhost:3000/api/workspace/diff?scope=uncommitted")).json();
  report("X11", "an approved file edit lands in the workspace and in the read-only Uncommitted view",
    !!ask && /\+\+\+ b\/notes\/hello.txt/.test(diff.diff) && /\+hello from cosmodex/.test(diff.diff), JSON.stringify(diff).slice(0, 300));
}

// Plan mode: the agent's question reaches the browser and the answer goes back.
const planThread = await rpc("thread/start", {});
if (planThread.body.result) {
  const tid = planThread.body.result.thread.id;
  const plan = { mode: "plan", settings: { model: "gpt-5.6-terra", reasoning_effort: null, developer_instructions: null } };
  const forced = await rpc("turn/start", { threadId: tid, input: [], collaborationMode: { ...plan, settings: { ...plan.settings, developer_instructions: "skip the task" } } });
  report("X12", "plan mode can't carry custom developer instructions", forced.status === 403 && forced.body.error?.data?.blocked, JSON.stringify(forced.body));
  await rpc("turn/start", { threadId: tid, input: [{ type: "text", text: "ASK how to fix it", text_elements: [] }], collaborationMode: plan });
  const q = await ev.waitFor((m) => m.id !== undefined && m.method === "item/tool/requestUserInput" && m.params?.threadId === tid);
  let answered = false;
  if (q) {
    const res = await fetch(`${G}/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: String(q.id), result: { answers: { approach: { answers: ["Fix the operator (Recommended)"] } } } }) });
    answered = res.status === 200;
  }
  const done = await ev.waitFor((m) => m.method === "turn/completed" && m.params?.threadId === tid);
  report("X13", "a plan-mode question reaches the browser, the answer goes back, and the turn completes", !!q && answered && !!done, JSON.stringify(q?.params ?? null).slice(0, 200));
}

// Chat actions: rename, fork, archive and restore go through; a fork can't widen the sandbox.
const chat = await rpc("thread/start", {});
if (chat.body.result) {
  const tid = chat.body.result.thread.id;
  await rpc("turn/start", { threadId: tid, input: [{ type: "text", text: "hello", text_elements: [] }] });
  await ev.waitFor((m) => m.method === "turn/completed" && m.params?.threadId === tid);
  const named = await rpc("thread/name/set", { threadId: tid, name: "Renamed chat" });
  const read = await rpc("thread/read", { threadId: tid });
  const forked = await rpc("thread/fork", { threadId: tid });
  const wide = await rpc("thread/fork", { threadId: tid, sandbox: "danger-full-access" });
  const archived = await rpc("thread/archive", { threadId: tid });
  const listed = await rpc("thread/list", { archived: true, limit: 50 });
  const restored = await rpc("thread/unarchive", { threadId: tid });
  report("X14", "rename, fork, archive and restore work; a fork with a wider sandbox is refused",
    named.status === 200 && read.body.result?.thread?.name === "Renamed chat" &&
      forked.status === 200 && forked.body.result?.thread?.id !== tid && forked.body.result?.approvalPolicy === "untrusted" &&
      wide.status === 403 && archived.status === 200 && restored.status === 200 &&
      (listed.body.result?.data ?? []).some((t) => t.id === tid),
    JSON.stringify([named.status, read.body.result?.thread?.name, forked.status, forked.body.result?.approvalPolicy, wide.status, archived.status, listed.status, restored.status]));
}

// Follow-up "Steer": a message sent into a running turn reaches the model in that same turn.
const steer = await rpc("thread/start", {});
if (steer.body.result) {
  const tid = steer.body.result.thread.id;
  const t = await rpc("turn/start", { threadId: tid, input: [{ type: "text", text: "WAIT: 4", text_elements: [] }] });
  const turnId = t.body.result?.turn?.id;
  const steered = await rpc("turn/steer", { threadId: tid, expectedTurnId: turnId, input: [{ type: "text", text: "steered in", text_elements: [] }] });
  const done = await ev.waitFor((m) => m.method === "turn/completed" && m.params?.threadId === tid);
  const reply = ev.seen.find((m) => m.method === "item/completed" && m.params?.threadId === tid && m.params?.turnId === turnId && /steered in/.test(m.params?.item?.text ?? ""));
  report("X15", "a steered follow-up joins the running turn", steered.status === 200 && !!done && !!reply, JSON.stringify([steered.status, steered.body]).slice(0, 300));
}

// Composer inputs: file search and file chips stay in the workspace; skills must be the engine's own.
const files = await rpc("fuzzyFileSearch", { query: "hello", roots: [WS], cancellationToken: null });
const filesOut = await rpc("fuzzyFileSearch", { query: "passwd", roots: ["/etc"], cancellationToken: null });
const skills = await rpc("skills/list", { cwds: [WS] });
const skill = skills.body.result?.data?.flatMap((e) => e.skills).find((k) => k.enabled);
const inputs = await rpc("thread/start", {});
if (inputs.body.result) {
  const tid = inputs.body.result.thread.id;
  const text = (t) => ({ type: "text", text: t, text_elements: [] });
  const outside = await rpc("turn/start", { threadId: tid, input: [text("read"), { type: "mention", name: "passwd", path: "/etc/passwd" }] });
  const forged = await rpc("turn/start", { threadId: tid, input: [text("go"), { type: "skill", name: "x", path: "/etc/passwd" }] });
  let used = { status: 200 };
  if (skill) {
    used = await rpc("turn/start", { threadId: tid, input: [text("draw"), { type: "skill", name: skill.name, path: skill.path }] });
    await ev.waitFor((m) => m.method === "turn/completed" && m.params?.threadId === tid);
  }
  report("X16", "file search and file chips stay in the workspace; only the engine's own skills can be used",
    (files.body.result?.files ?? []).some((f) => f.path === "notes/hello.txt") && filesOut.status === 403 &&
      outside.status === 403 && forged.status === 403 && used.status === 200,
    JSON.stringify([files.body.result?.files?.length, filesOut.status, outside.status, forged.status, used.status, skill?.name ?? "no skills"]));
}

// The terminal: this task leaves it off, so the terminal's shell can't be started.
const term = await rpc("command/exec", { command: ["/opt/agentsim/bin/terminal-shell"], processId: "t1", tty: true, cwd: WS });
const shell = await rpc("thread/shellCommand", { threadId: "x", command: "id" });
report("X17", "without a terminal in the task, the terminal and the direct shell are refused",
  term.status === 403 && /terminal/.test(term.body.error?.message ?? "") && shell.status === 403, JSON.stringify([term.status, term.body.error?.message, shell.status]));

ev.close();
process.exit(failed ? 1 : 0);
