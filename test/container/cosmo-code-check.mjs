// Run inside the test container as the session user: drives the Cosmo Code gateway against the
// engine host and the pinned Claude Code engine, and prints one "PASS|FAIL <id> <description>"
// line per check.
const G = "http://localhost:3000/engine/cosmo-code";
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

// @ mentions search the workspace; the app's own tools (task list, next step) never ask.
const found = await rpc("files/search", { query: "hello", limit: 10 });
const outside = await rpc("files/search", { query: "passwd", root: "/etc" });
report("C11", "file search lists workspace files, and only takes a query",
  (found.body.result?.files ?? []).includes("notes/hello.txt") && outside.status === 403, JSON.stringify([found.body, outside.status]).slice(0, 300));
const plan = { items: [{ content: "Read the module", status: "completed" }, { content: "Write tests", status: "in_progress" }] };
const app = await rpc("session/send", { text: `CALL: mcp__cosmo_turn__update_plan ${JSON.stringify(plan)}` });
const appSid = app.body.result?.sessionId;
const appDone = await ev.waitFor((m) => m.method === "session/message" && m.params?.sessionId === appSid && m.params.message?.type === "result");
const asked = ev.seen.some((m) => m.method === "session/permission" && m.params?.sessionId === appSid);
const shown = ev.seen.some((m) => m.method === "session/message" && m.params?.sessionId === appSid && JSON.stringify(m.params.message).includes("Task list shown."));
report("C12", "the app's task list tool runs without a permission prompt", !!appDone && !asked && shown, JSON.stringify([!!appDone, asked, shown]));

// The panes: this task has no terminal; files are read inside the workspace only (a link out of it
// included).
const term = await rpc("terminal/open", { cols: 80, rows: 24 });
report("C13", "the terminal is refused when the task doesn't enable it", term.status === 403 && term.body.error?.data?.blocked, JSON.stringify(term));
const { symlinkSync, rmSync } = await import("node:fs");
rmSync("/usercode/FILESYSTEM/notes/out", { force: true });
symlinkSync("/etc/passwd", "/usercode/FILESYSTEM/notes/out");
const tree = await rpc("files/tree", {});
const hello = await rpc("files/read", { path: "notes/hello.txt" });
const reads = await Promise.all(["/etc/passwd", "../../etc/passwd", "notes/out"].map((path) => rpc("files/read", { path })));
rmSync("/usercode/FILESYSTEM/notes/out", { force: true });
report("C14", "files list and read inside the workspace; absolute paths, .. and links out are refused",
  (tree.body.result?.files ?? []).includes("notes/hello.txt") && typeof hello.body.result?.content === "string" && reads.every((r) => r.body.error && !r.body.result),
  JSON.stringify([tree.status, hello.body, reads.map((r) => [r.status, r.body.error?.message])]).slice(0, 300));

// Rewind: the conversation goes back to before a prompt, and Undo brings it back.
const prompts = (messages) => messages.filter((m) => m.type === "user" && !(Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === "tool_result")) && !/^\s*</.test(typeof m.message?.content === "string" ? m.message.content : m.message?.content?.[0]?.text ?? ""));
const turn = async (params) => {
  const r = await rpc("session/send", params);
  const id = r.body.result?.sessionId;
  await ev.waitFor((m) => m.method === "session/message" && m.params?.sessionId === id && m.params.message?.type === "result" && !seenResults.has(m));
  for (const m of ev.seen) if (m.params?.message?.type === "result") seenResults.add(m);
  return id;
};
const seenResults = new Set(ev.seen.filter((m) => m.params?.message?.type === "result"));
const rsid = await turn({ text: "first prompt" });
await turn({ sessionId: rsid, text: "second prompt" });
const before = prompts((await rpc("session/read", { sessionId: rsid })).body.result?.messages ?? []);
const firstRefused = await rpc("session/rewind", { sessionId: rsid, userMessageId: before[0]?.uuid });
const rewound = await rpc("session/rewind", { sessionId: rsid, userMessageId: before[1]?.uuid });
const during = (await rpc("session/read", { sessionId: rsid })).body.result;
const undone = await rpc("session/undoRewind", { sessionId: rsid });
const after = prompts((await rpc("session/read", { sessionId: rsid })).body.result?.messages ?? []);
report("C15", "rewind removes a prompt and what followed (not the first), and Undo rewind brings it back",
  before.length === 2 && firstRefused.body.error && !firstRefused.body.result && rewound.body.result?.text === "second prompt" && prompts(during?.messages ?? []).length === 1 && during?.rewound?.userMessageId === before[1].uuid && undone.status === 200 && after.length === 2,
  JSON.stringify([before.length, firstRefused.body, rewound.body, prompts(during?.messages ?? []).length, undone.status, after.length]).slice(0, 300));

// Sessions run on Claude Code's own system prompt (thousands of characters; without it the SDK
// sends only a one-line identity), with the candidate's instructions (Settings) appended for a
// new session. The stub logs each system prompt's start, end and length.
const { readFileSync } = await import("node:fs");
const marker = `INSTRUCTIONS-${Date.now()}`;
await turn({ text: "instructions check", instructions: `Answer briefly. ${marker}` });
// The engine's main-loop requests (those offering tools) in this run: every one on Claude Code's prompt.
const main = readFileSync(process.env.STUB_LOG ?? "/tmp/stub.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.at >= started && r.ua?.includes("agent-sdk") && r.tools?.length && r.systemHead);
const instructed = main.filter((r) => r.systemTail.endsWith(marker));
const tooLong = await rpc("session/send", { text: "hi", instructions: "x".repeat(4001) });
report("C16", "sessions get Claude Code's system prompt, with the candidate's instructions appended (short text only)",
  main.length > 0 && main.every((r) => r.systemChars > 2000 && r.systemHead.includes("You are an interactive agent")) && instructed.length > 0 && tooLong.status === 403,
  JSON.stringify([main.length, instructed.length, main.map((r) => r.systemChars), tooLong.status]));

// Subagents: the engine reports the task live, and its conversation reads back by the id the
// Agent call's result names (only an engine-shaped id passes).
const asid = await turn({ text: 'CALL: Agent {"description":"Survey test files","prompt":"List the test files.","subagent_type":"general-purpose"}' });
const taskStarted = await ev.waitFor((m) => m.params?.sessionId === asid && m.params?.message?.subtype === "task_started", 10000);
const ended = await ev.waitFor((m) => m.params?.sessionId === asid && m.params?.message?.subtype === "task_notification", 30000);
const agentId = taskStarted?.params.message.task_id;
const sub = agentId ? await rpc("session/subagent", { sessionId: asid, agentId }) : null;
const subPrompt = sub?.body.result?.messages?.[0]?.message?.content;
const badSub = await rpc("session/subagent", { sessionId: asid, agentId: "../../../etc/passwd" });
report("C17", "a subagent's task is reported live, and its own conversation reads back by its id",
  taskStarted?.params.message.task_type === "local_agent" && !!ended && (typeof subPrompt === "string" ? subPrompt : JSON.stringify(subPrompt)).includes("List the test files.") && badSub.status === 403,
  JSON.stringify([!!taskStarted, !!ended, agentId, sub?.body.result?.messages?.length, badSub.status]));

ev.close();
process.exit(failed ? 1 : 0);
