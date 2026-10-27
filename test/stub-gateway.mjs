// Stub LLM gateway for tests. Stands in for the platform LLM proxy:
// speaks Anthropic /v1/messages and OpenAI /v1/responses + /v1/chat/completions,
// enforces a per-key model allowlist, and logs every request to requests.jsonl.
//
// Scripted replies: `CALL: <tool> <json>` calls exactly that tool; `RUN: <command>` calls whichever
// shell tool the client offered; otherwise a plain text echo.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 4000);
const LOG = process.env.STUB_LOG || new URL("./requests.jsonl", import.meta.url).pathname;
// Full request bodies, for working out what a client sends (off unless set).
const DUMP = process.env.STUB_DUMP;

// key -> allowed models. "*" allows everything (control key).
const SCOPED = ["claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.6-terra", "gpt-6-luna"];
const KEYS = {
  "test-key-scoped": SCOPED,
  "test-key-open": ["*"],
};
const ALL_MODELS = [
  "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5",
  "gpt-5.6-terra", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra",
];

const id = (p) => `${p}_${crypto.randomBytes(8).toString("hex")}`;
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

function keyOf(req) {
  const auth = req.headers["authorization"] || "";
  return req.headers["x-api-key"] || auth.replace(/^Bearer\s+/i, "") || null;
}

function allowed(key, model) {
  const list = KEYS[key];
  if (!list) return { ok: false, status: 401, why: "unknown key" };
  if (list.includes("*") || list.includes(model)) return { ok: true };
  return { ok: false, status: 403, why: `model ${model} not allowed for this key` };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c.text ?? c.input_text ?? (typeof c.content === "string" ? c.content : "")).join("\n");
}

// Latest user-authored text, or null when the last turn is a tool result (then we just finish).
// Claude Code follows the prompt with more user and "system" messages (context), so every user
// message since the last reply counts.
function lastUserText(messages) {
  const last = messages[messages.length - 1];
  if (!last) return "";
  if (last.role === "tool") return null;
  if (last.type === "function_call_output" || last.type === "custom_tool_call_output") return null;
  const isResult = (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result" || c.type === "function_call_output");
  const turn = [];
  for (let i = messages.length - 1; i >= 0 && (messages[i].role === "user" || messages[i].role === "system"); i--) {
    if (messages[i].role === "user") turn.unshift(messages[i]);
  }
  if (!turn.length) return textOf(last.content);
  if (turn.some(isResult)) return null;
  return turn.map((m) => textOf(m.content)).join("\n");
}

// Pick a shell-like tool and build arguments from its schema.
function shellCall(tools, command) {
  const norm = (t) => ({
    name: t.name ?? t.function?.name,
    schema: t.input_schema ?? t.parameters ?? t.function?.parameters ?? {},
  });
  const cands = (tools || []).map(norm).filter((t) => t.name && /^(bash|shell|exec_command|local_shell|run_terminal_cmd)$/i.test(t.name));
  const tool = cands[0] || (tools || []).map(norm).find((t) => /bash|shell|exec/i.test(t.name || ""));
  if (!tool) return null;
  const props = tool.schema.properties || {};
  const args = {};
  for (const [k, v] of Object.entries(props)) {
    if (/^(command|cmd)$/.test(k)) args[k] = v.type === "array" ? ["bash", "-lc", command] : command;
    else if (k === "description") args[k] = "test command";
  }
  if (!Object.keys(args).length) args.command = command;
  return { name: tool.name, args };
}

function plan(model, userText, tools) {
  if (userText === null) return { kind: "text", text: `done (model=${model})` };
  // CALL: <tool> <json input> calls exactly that tool, when the client offers it.
  const call = /CALL:\s*(\S+)\s+(\{.*\})/.exec(userText || "");
  if (call && (tools || []).some((t) => (t.name ?? t.function?.name) === call[1])) {
    try {
      return { kind: "tool", name: call[1], args: JSON.parse(call[2]) };
    } catch {
      /* not JSON: answer with text */
    }
  }
  const m = /RUN:\s*(.+)/.exec(userText || "");
  if (m) {
    const call = shellCall(tools, m[1].trim());
    if (call) return { kind: "tool", ...call };
  }
  return { kind: "text", text: `stub reply from ${model}. You said: ${(userText || "").slice(0, 200)}` };
}

function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  return (event, data) => res.write((event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`);
}

const usage = { input_tokens: 10, output_tokens: 5 };

/** The prompt that started the current turn (tool results and replies since then don't count). */
function turnPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result") ? "" : textOf(m.content);
    if (/\S/.test(text) && !/^\s*<system-reminder>/.test(text)) return text;
  }
  return "";
}

function anthropic(req, res, body, waited = false) {
  // WAIT: <seconds> holds back every reply of that turn, so it stays in progress (task list, Stop).
  const wait = waited ? null : /\bWAIT:\s*(\d+)/.exec(turnPrompt(body.messages || []));
  if (wait) return void setTimeout(() => anthropic(req, res, body, true), Number(wait[1]) * 1000);
  const p = plan(body.model, lastUserText(body.messages || []), body.tools);
  const msgId = id("msg");
  const blocks = p.kind === "tool"
    ? [{ type: "tool_use", id: id("toolu"), name: p.name, input: p.args }]
    : [{ type: "text", text: p.text }];
  const stop = p.kind === "tool" ? "tool_use" : "end_turn";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: msgId, type: "message", role: "assistant", model: body.model, content: blocks, stop_reason: stop, stop_sequence: null, usage }));
  }
  const send = sse(res);
  send("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send("content_block_stop", { type: "content_block_stop", index: i });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

/** Codex "code mode": tools are offered as one custom `exec` tool taking JavaScript. */
function codeModeExec(input) {
  for (const item of input) {
    if (item?.type !== "additional_tools") continue;
    for (const group of item.tools ?? []) {
      for (const tool of group.tools ?? [group]) if (tool.type === "custom" && tool.name === "exec") return tool;
    }
  }
  return null;
}

/** Whether Codex offered a plain function tool by this name (e.g. request_user_input in plan mode). */
function offersFunction(input, name) {
  return input.some((item) => item?.type === "additional_tools" && (item.tools ?? []).some((g) => (g.tools ?? [g]).some((t) => t.type === "function" && t.name === name)));
}

const STUB_PLAN = [
  "Here is the plan.",
  "",
  "<proposed_plan>",
  "# Fix add() in calc.py",
  "",
  "## Summary",
  "`add` subtracts instead of adding.",
  "",
  "## Steps",
  "1. Change `return a - b` to `return a + b` in `calc.py`.",
  "2. Add a test for `add(2, 3) == 5`.",
  "</proposed_plan>",
].join("\n");

const STUB_MARKDOWN = [
  "## Summary",
  "Here is **bold**, *italic*, `inline code` and a [link](https://example.com).",
  "",
  "- one",
  "- two",
  "",
  "1. first",
  "2. second",
  "",
  "```python",
  'def greet(name):',
  '    return f"Hello, {name}! This line is long enough to show what word wrap does in a narrow code block."',
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "| 3 | 4 |",
  "",
  "> A quote.",
].join("\n");

/**
 * Codex scripts. RUN: <cmd> runs a command; ADD: <path> <text> creates a file; REPLACE: <path>
 * "<old line>" => "<new line>" edits one line (quotes keep the indentation exact); ASK asks a question (plan mode); PLANTEXT answers with a plan.
 * WAIT: <seconds> holds the reply back (Claude: every reply of the turn), so a turn stays in progress.
 * MD answers with Markdown: heading, emphasis, lists, a code block, a table and a quote.
 */
function codexScript(input, user) {
  const exec = (code) => ({ kind: "custom", name: "exec", input: code });
  const patch = (body) => exec(`await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n${body}\n*** End Patch\n`)});`);
  if (!codeModeExec(input) || user === null) return null;
  let m;
  if ((m = /RUN:\s*([\s\S]+)$/m.exec(user))) return exec(`await tools.exec_command(${JSON.stringify({ cmd: m[1].trim() })});`);
  if ((m = /ADD:\s*(\S+)\s+([\s\S]+)$/m.exec(user))) return patch(`*** Add File: ${m[1]}\n+${m[2].trim()}`);
  if ((m = /REPLACE:\s*(\S+)\s+"([^"]*)"\s*=>\s*"([^"]*)"/.exec(user))) return patch(`*** Update File: ${m[1]}\n@@\n-${m[2]}\n+${m[3]}`);
  if (/\bASK\b/.test(user) && offersFunction(input, "request_user_input")) {
    return {
      kind: "tool",
      name: "request_user_input",
      args: {
        questions: [
          {
            id: "approach",
            header: "Approach",
            question: "How should add() be fixed?",
            options: [
              { label: "Fix the operator (Recommended)", description: "Change - to + and keep the signature." },
              { label: "Rewrite the function", description: "Replace add() with a new implementation." },
            ],
          },
        ],
      },
    };
  }
  if (/\bPLANTEXT\b/.test(user)) return { kind: "text", text: STUB_PLAN };
  if (/\bMD\b/.test(user)) return { kind: "text", text: STUB_MARKDOWN };
  return null;
}

function responses(req, res, body, waited = false) {
  const input = Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }];
  const wait = waited ? null : /\bWAIT:\s*(\d+)/.exec(lastUserText(input) ?? "");
  if (wait) return void setTimeout(() => responses(req, res, body, true), Number(wait[1]) * 1000);
  let p = plan(body.model, lastUserText(input), body.tools);
  const scripted = p.kind === "text" ? codexScript(input, lastUserText(input)) : null;
  if (scripted) p = scripted;
  const respId = id("resp");
  const item = p.kind === "tool"
    ? { type: "function_call", id: id("fc"), call_id: id("call"), name: p.name, arguments: JSON.stringify(p.args), status: "completed" }
    : p.kind === "custom"
      ? { type: "custom_tool_call", id: id("ctc"), call_id: id("call"), name: p.name, input: p.input, status: "completed" }
      : { type: "message", id: id("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: p.text, annotations: [] }] };
  const u = { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const full = { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: body.model, output: [item], usage: u };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(full));
  }
  const send = sse(res);
  let seq = 0;
  const ev = (type, extra) => send(type, { type, sequence_number: seq++, ...extra });
  ev("response.created", { response: { ...full, status: "in_progress", output: [] } });
  ev("response.in_progress", { response: { ...full, status: "in_progress", output: [] } });
  const empty = item.type === "message" ? { content: [] } : item.type === "custom_tool_call" ? { input: "" } : { arguments: "" };
  ev("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...empty } });
  if (item.type === "message") {
    ev("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    ev("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: p.text });
    ev("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: p.text });
    ev("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  } else if (item.type === "custom_tool_call") {
    ev("response.custom_tool_call_input.delta", { item_id: item.id, output_index: 0, delta: item.input });
    ev("response.custom_tool_call_input.done", { item_id: item.id, output_index: 0, input: item.input });
  } else {
    ev("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments });
    ev("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: item.arguments });
  }
  ev("response.output_item.done", { output_index: 0, item });
  ev("response.completed", { response: full });
  res.end();
}

function chat(req, res, body) {
  const msgs = body.messages || [];
  const p = plan(body.model, lastUserText(msgs), body.tools);
  const cid = id("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = p.kind === "tool" ? [{ index: 0, id: id("call"), type: "function", function: { name: p.name, arguments: JSON.stringify(p.args) } }] : undefined;
  const finish = p.kind === "tool" ? "tool_calls" : "stop";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: cid, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: p.kind === "text" ? p.text : null, tool_calls: toolCalls }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  }
  const send = sse(res);
  const chunk = (delta, fr = null) => send(null, { id: cid, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: fr }] });
  chunk({ role: "assistant", ...(p.kind === "text" ? { content: p.text } : { tool_calls: toolCalls }) });
  chunk({}, finish);
  send(null, { id: cid, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const path = req.url.split("?")[0].replace(/^\/v1(?=\/)/, "").replace(/^\/openai(?=\/)/, "").replace(/^\/anthropic(?=\/)/, "");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON */ }
    const key = keyOf(req);
    if (DUMP && raw) fs.appendFileSync(DUMP, JSON.stringify({ url: req.url, body }) + "\n");
    const entry = { method: req.method, url: req.url, key: key ? key.slice(0, 14) : null, model: body.model ?? null, stream: !!body.stream, tools: (body.tools || []).map((t) => t.name ?? t.function?.name ?? t.type).slice(0, 40), ua: req.headers["user-agent"] };

    if (req.method === "GET" && path === "/models") {
      const list = (KEYS[key] || []).includes("*") ? ALL_MODELS : (KEYS[key] || []);
      log({ ...entry, status: KEYS[key] ? 200 : 401 });
      if (!KEYS[key]) { res.writeHead(401); return res.end(JSON.stringify({ error: { message: "unknown key" } })); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: list.map((m) => ({ id: m, object: "model", type: "model", display_name: m, created_at: "2026-01-01T00:00:00Z", owned_by: "stub" })), has_more: false }));
    }
    if (req.method === "POST" && path === "/messages/count_tokens") {
      log({ ...entry, status: 200 });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 42 }));
    }
    const route = { "/messages": anthropic, "/responses": responses, "/chat/completions": chat }[path];
    if (req.method !== "POST" || !route) {
      log({ ...entry, status: 404 });
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `stub has no ${req.method} ${req.url}` } }));
    }
    const gate = allowed(key, body.model);
    if (!gate.ok) {
      log({ ...entry, status: gate.status, why: gate.why });
      res.writeHead(gate.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: gate.status === 401 ? "authentication_error" : "permission_error", message: gate.why } }));
    }
    log({ ...entry, status: 200, lastUser: (lastUserText(body.messages || (Array.isArray(body.input) ? body.input : [])) || "").slice(0, 120) });
    try { route(req, res, body); } catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`stub gateway on :${PORT}, log ${LOG}`));
