// The transcript record for grading: per agent, every session's prompts, replies, tool calls and
// results, shell commands, file changes, tokens and mode switches, written in the format the
// platform's terminal agent provisioning writes (.codesignal/<engine>/interactions_summary.<N>.jsonl
// and timeline.<N>.part<k>.txt), so graders that read those files work unchanged. It is built from
// the engine's traffic through the gateway as it happens (adapters in server/gateways/*.mjs), not
// read back from the engine's own files afterwards.
//
// <N> is one more than the highest index already in the folder when the server starts, so a
// restart starts a new file pair and the earlier ones stay. Files are rewritten whole, a moment
// after each change.
import fs from "node:fs";
import path from "node:path";

const TIMELINE_PART_BYTES = 70_000;
const WRITE_DELAY_MS = 1500;
const RULE = "=".repeat(80);
const THIN = "─".repeat(80);

/** How graders group shell commands. */
export function commandCategory(command) {
  const c = String(command).trim();
  if (/(^|[\s;&|(])(pytest|jest|vitest|mocha|go test|cargo test|mvn( \S+)* test|gradle( \S+)* test|npm (run )?test|yarn test|pnpm test|bun test|rspec|phpunit|dotnet test|python -m (pytest|unittest))\b/.test(c)) return "test";
  if (/(^|[\s;&|(])(npm (i|install|ci)|yarn( add| install)?$|pnpm (i|install|add)|pip3? install|poetry (add|install)|apt(-get)? install|brew install|cargo add|go get|bundle install)\b/.test(c)) return "install";
  if (/(^|[\s;&|(])git\b/.test(c)) return "git";
  if (/(^|[\s;&|(])(npm run build|tsc|make|cargo build|go build|mvn|gradle|webpack|vite build)\b/.test(c)) return "build";
  if (/^(ls|cat|head|tail|grep|rg|find|tree|wc|less|sed -n|pwd|which|file|stat)\b/.test(c)) return "inspect";
  if (/(^|[\s;&|(])(node|python3?|ruby|go run|cargo run|java|bash|sh|npm start|npm run)\b/.test(c)) return "run";
  return "other";
}

const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const addTokens = (into, usage) => {
  for (const [k, v] of Object.entries(usage ?? {})) if (typeof v === "number") into[k] = (into[k] ?? 0) + v;
};
const indent = (text) => String(text ?? "").split("\n").map((l) => `  ${l}`).join("\n");

/** The text a tool result carries, for errors (kept in full, as the provisioner keeps it). */
export const resultText = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("\n") : content == null ? "" : JSON.stringify(content);

/**
 * @param dir      the output folder, e.g. <workspace>/.codesignal/claude
 * @param agent    the agent id (recorded on every session line)
 * @param project  the workspace path
 * @param modeKey  "permission" (Claude Code, OpenCode) or "approval" (Codex): which field names
 *                 the session line uses for mode switches, as the provisioner does per engine
 */
export function createTranscript({ dir, agent, project, modeKey = "permission", now = () => new Date(), delay = WRITE_DELAY_MS }) {
  const sessions = new Map();
  let index = null;
  let timer = null;

  const session = (id) => {
    let s = sessions.get(id);
    if (!s) {
      const at = iso(now());
      sessions.set(id, (s = { id, startedAt: at, endedAt: at, model: null, mode: null, modes: [], tokens: {}, interactions: [], tools: new Map(), timeline: [] }));
    }
    return s;
  };
  const current = (s) => s.interactions.at(-1);
  const touch = (s) => {
    s.endedAt = iso(now());
    schedule();
  };
  const line = (s, label, body) => s.timeline.push(`[${iso(now())}]  ${label}${body === undefined ? "" : `\n${indent(body)}`}`);

  function schedule() {
    if (timer || !dir) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        flush();
      } catch {
        /* the workspace may be gone; the next change tries again */
      }
    }, delay);
    timer.unref?.();
  }

  function nextIndex() {
    if (index !== null) return index;
    let max = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = /^interactions_summary\.(\d+)\.jsonl$/.exec(f);
        if (m) max = Math.max(max, Number(m[1]));
      }
    } catch {
      /* no folder yet */
    }
    return (index = max + 1);
  }

  const rec = {
    /** The model a session runs (from the engine, or a switch). */
    model(id, model) {
      if (!id || !model) return;
      session(id).model = String(model);
    },
    /** A permission (or Codex approval) mode, at the start or on a switch. */
    mode(id, mode) {
      if (!id || !mode) return;
      const s = session(id);
      if (s.mode === mode) return;
      s.mode = String(mode);
      s.modes.push({ mode: s.mode, timestamp: iso(now()) });
      line(s, `MODE → ${s.mode}`);
      touch(s);
    },
    /** The candidate's prompt: a new interaction. */
    prompt(id, text) {
      if (!id || typeof text !== "string" || !text.trim()) return;
      const s = session(id);
      const prev = current(s);
      s.interactions.push({
        at: iso(now()),
        prevAt: prev?.at ?? null,
        input: text,
        model: s.model,
        mode: s.mode,
        texts: [],
        tools: [],
        results: [],
        commands: [],
        files: [],
        tokens: {},
      });
      line(s, "USER:", text);
      touch(s);
    },
    /** The agent's reply text (each block once). */
    text(id, text) {
      if (!id || typeof text !== "string" || !text.trim()) return;
      const s = session(id);
      current(s)?.texts.push(text);
      line(s, s.mode === "plan" ? "ASSISTANT (plan mode):" : "ASSISTANT:", text);
      touch(s);
    },
    /** A tool call: the shell command or file it names, when it names one. */
    tool(id, { callId, name, command, file, action = "ai_edit" }) {
      if (!id || !name) return;
      const s = session(id);
      if (callId) s.tools.set(callId, name);
      const i = current(s);
      i?.tools.push(name);
      if (command) rec.command(id, { command });
      if (file) rec.file(id, { path: file, action });
      touch(s);
    },
    /** A tool's result: errors are kept in full. */
    result(id, { callId, name, isError, errorText }) {
      if (!id) return;
      const s = session(id);
      const tool = name ?? (callId ? s.tools.get(callId) : null) ?? null;
      current(s)?.results.push({ tool_use_id: callId ?? null, tool_name: tool, is_error: !!isError, error_text: isError ? String(errorText ?? "") : null });
      if (isError) line(s, `TOOL ERROR (${tool ?? "unknown"}):`, errorText);
      touch(s);
    },
    /** A shell command the agent ran, with its output when the engine reports it. */
    command(id, { command, output, exitCode }) {
      if (!id || !command) return;
      const s = session(id);
      current(s)?.commands.push({ command: String(command), category: commandCategory(command), ...(exitCode !== undefined ? { exit_code: exitCode } : {}) });
      line(s, "COMMAND:", output !== undefined ? `$ ${command}\n${output}` : `$ ${command}`);
      touch(s);
    },
    /** A file the agent changed: ai_edit, ai_write or ai_delete. */
    file(id, { path: file, action = "ai_edit" }) {
      if (!id || !file) return;
      const s = session(id);
      const i = current(s);
      if (i && !i.files.some((f) => f.path === file && f.action === action)) i.files.push({ path: String(file), action });
      line(s, `FILE ${action === "ai_write" ? "WRITTEN" : action === "ai_delete" ? "DELETED" : "EDITED"}: ${file}`);
      touch(s);
    },
    /** Token usage of one model response (added up per interaction and session). */
    tokens(id, usage) {
      if (!id || !usage) return;
      const s = session(id);
      addTokens(s.tokens, usage);
      const i = current(s);
      if (i) addTokens(i.tokens, usage);
      touch(s);
    },
    /** The turn ended. */
    end(id) {
      if (!id || !sessions.has(id)) return;
      touch(session(id));
    },
    /** The records as they'd be written: { summary: lines, timeline: text }. */
    render,
    flush,
  };

  function sessionLine(s) {
    const results = s.interactions.flatMap((i) => i.results);
    const errors = results.filter((r) => r.is_error);
    const byTool = {};
    for (const r of errors) byTool[r.tool_name ?? "unknown"] = (byTool[r.tool_name ?? "unknown"] ?? 0) + 1;
    const calls = s.interactions.reduce((n, i) => n + i.tools.length, 0);
    const commands = s.interactions.flatMap((i) => i.commands);
    const categories = {};
    for (const c of commands) categories[c.category] = (categories[c.category] ?? 0) + 1;
    const files = new Set(s.interactions.flatMap((i) => i.files.map((f) => f.path)));
    const gaps = s.interactions.slice(1).map((i, k) => Date.parse(i.at) - Date.parse(s.interactions[k].at));
    const modes = [...new Set(s.modes.map((m) => m.mode))].sort();
    return {
      kind: "session",
      session_id: s.id,
      agent,
      project_path: project,
      project_name: path.basename(project),
      started_at: s.startedAt,
      ended_at: s.endedAt,
      duration_seconds: Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000),
      num_user_messages: s.interactions.length,
      num_assistant_messages: s.interactions.reduce((n, i) => n + i.texts.length, 0),
      num_tool_calls: calls,
      num_tool_errors: errors.length,
      tool_error_rate: calls ? Math.round((errors.length / calls) * 1000) / 1000 : 0,
      tool_errors_by_tool: sorted(byTool),
      tools_used: [...new Set(s.interactions.flatMap((i) => i.tools))].sort(),
      used_plan_mode: modes.includes("plan"),
      [`${modeKey}_modes_used`]: modes,
      [`${modeKey}_mode_transitions`]: s.modes,
      num_files_edited_by_ai: files.size,
      num_bash_commands: commands.length,
      bash_categories: sorted(categories),
      tokens: s.tokens,
      model: s.model,
      pacing: gaps.length ? { avg_gap_ms: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), min_gap_ms: Math.min(...gaps), max_gap_ms: Math.max(...gaps) } : null,
    };
  }

  const interactionLine = (s, i, k) => ({
    kind: "interaction",
    session_id: s.id,
    interaction_id: `${s.id}:${k + 1}`,
    timestamp: i.at,
    input_text: i.input,
    input_source: "typed",
    duration_from_previous_ms: i.prevAt ? Date.parse(i.at) - Date.parse(i.prevAt) : null,
    assistant_response_present: i.texts.length > 0,
    assistant_response_text: i.texts.join("\n\n"),
    model: i.model,
    mode: i.mode,
    tools_used: [...new Set(i.tools)],
    num_tool_calls: i.tools.length,
    tool_results: i.results,
    bash_commands: i.commands,
    files_touched: i.files,
    tokens: i.tokens,
  });

  function render() {
    const list = [...sessions.values()].filter((s) => s.interactions.length || s.modes.length).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const summary = list.flatMap((s) => [sessionLine(s), ...s.interactions.map((i, k) => interactionLine(s, i, k))]);
    const timeline = list
      .map((s) => {
        const files = [...new Map(s.interactions.flatMap((i) => i.files).map((f) => [f.path, f])).values()];
        const tokens = Object.entries(s.tokens).map(([k, v]) => `    ${k.padEnd(24)} ${v.toLocaleString("en-US")}`).join("\n");
        return [
          RULE,
          `SESSION: ${s.id}`,
          `  agent:   ${agent}`,
          `  project: ${project}`,
          ...(s.model ? [`  model:   ${s.model}`] : []),
          `  started: ${s.startedAt}`,
          `  ended:   ${s.endedAt}`,
          ...(tokens ? ["  tokens:", tokens] : []),
          RULE,
          "",
          s.timeline.join("\n\n"),
          ...(files.length ? ["", THIN, "FILES CHANGED (summary):", ...files.map((f) => `  ${f.action.replace("ai_", "").padStart(7)} | ${f.path}`), THIN] : []),
          "",
        ].join("\n");
      })
      .join("\n");
    return { summary, timeline };
  }

  /** Splits text into parts of at most `max` bytes, on character boundaries. */
  function parts(text, max = TIMELINE_PART_BYTES) {
    const out = [];
    let buf = "";
    let bytes = 0;
    for (const ch of text) {
      const n = Buffer.byteLength(ch);
      if (bytes + n > max) {
        out.push(buf);
        buf = "";
        bytes = 0;
      }
      buf += ch;
      bytes += n;
    }
    if (buf || !out.length) out.push(buf);
    return out;
  }

  function flush() {
    if (!dir) return;
    const { summary, timeline } = render();
    if (!summary.length) return;
    const n = nextIndex();
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(path.join(dir, `interactions_summary.${n}.jsonl`), summary.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const chunks = parts(timeline);
    chunks.forEach((chunk, k) => writeAtomic(path.join(dir, `timeline.${n}.part${k + 1}.txt`), chunk));
    // Fewer parts than last time (never, as the record only grows; kept for safety).
    for (let k = chunks.length + 1; fs.existsSync(path.join(dir, `timeline.${n}.part${k}.txt`)); k++) fs.rmSync(path.join(dir, `timeline.${n}.part${k}.txt`));
  }

  return rec;
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
