// The turn record: each turn's prompt, the model and mode it ran with, the tools the agent used and
// how it ended, written to the event log by the gateways from the engine's own messages. Unlike the
// engines' transcripts (in the session user's home, which the agent and candidate can change), the
// event log belongs to the server's user, so this is the record evaluation can trust.

const PROMPT_MAX = 4000;
const SESSIONS_MAX = 500;

/**
 * @param events   the event log
 * @param gateway  the gateway's name ("claude", "codex", "opencode")
 * @param agent    the agent id
 */
export function createTurnRecorder({ events, gateway, agent }) {
  const sessions = new Map(); // session id → { model, mode, tools: { name: count }, open }
  const of = (sessionId) => {
    let s = sessions.get(sessionId);
    if (!s) {
      if (sessions.size >= SESSIONS_MAX) sessions.delete(sessions.keys().next().value);
      sessions.set(sessionId, (s = { model: null, mode: null, tools: {}, open: false }));
    }
    return s;
  };
  const record = (type, detail) => events?.record(type, { gateway, agent, ...detail });
  return {
    /** The model or mode a session runs with (known before, or learned during, a turn). */
    settings(sessionId, { model, mode } = {}) {
      if (!sessionId) return;
      const s = of(sessionId);
      if (model) s.model = String(model);
      if (mode) s.mode = String(mode);
    },
    /** A prompt went in: a new turn, or (steer) one added to the running turn. */
    start(sessionId, { prompt, model, mode, steer = false }) {
      if (!sessionId) return;
      this.settings(sessionId, { model, mode });
      const s = of(sessionId);
      s.open = true;
      const text = typeof prompt === "string" ? prompt : "";
      record("turn", {
        sessionId,
        prompt: text.length > PROMPT_MAX ? `${text.slice(0, PROMPT_MAX)}…` : text,
        promptChars: text.length,
        model: s.model,
        mode: s.mode,
        ...(steer ? { steer: true } : {}),
      });
    },
    /** The agent used a tool. */
    tool(sessionId, name) {
      if (!sessionId || !name) return;
      const tools = of(sessionId).tools;
      tools[name] = (tools[name] ?? 0) + 1;
    },
    /** Whether a prompted turn is under way. */
    isOpen: (sessionId) => !!sessions.get(sessionId)?.open,
    /** The turn ended: "completed", "interrupted", "failed", … A turn the engine started by itself
     * (no prompt, e.g. after a background task finished) is marked as a follow-up. */
    end(sessionId, outcome) {
      if (!sessionId) return;
      const s = of(sessionId);
      record("turn-end", { sessionId, outcome: String(outcome ?? "completed"), model: s.model, mode: s.mode, tools: s.tools, ...(s.open ? {} : { followUp: true }) });
      s.tools = {};
      s.open = false;
    },
  };
}

/** The text of a list of input blocks ({ type: "text", text }). */
export const inputText = (input) =>
  Array.isArray(input)
    ? input
        .filter((i) => i?.type === "text" && typeof i.text === "string")
        .map((i) => i.text)
        .join("\n")
    : "";
