// Validation for the task's agent-sim.json. Every problem is reported at once, so a task
// author fixes a config in one round trip. A task can only narrow what pins.json allows.
import fs from "node:fs";

export const PINS = JSON.parse(fs.readFileSync(new URL("./pins.json", import.meta.url), "utf8"));

const KEYS = new Set(["agents", "default", "allowSwitch", "terminal", "sandbox", "webTools", "models"]);
const TERMINAL = ["off", "sandboxed"];

const isBool = (v) => typeof v === "boolean";
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * @returns {{ ok: true, config: object } | { ok: false, errors: string[] }}
 */
export function validateTaskConfig(raw, pins = PINS) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["config must be a JSON object"] };
  }
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) errors.push(`unknown key "${key}"`);
  }

  const known = Object.keys(pins.agents);
  let agents = [];
  if (!isStringArray(raw.agents) || raw.agents.length === 0) {
    errors.push(`"agents" must be a non-empty array of: ${known.join(", ")}`);
  } else {
    for (const a of raw.agents) if (!known.includes(a)) errors.push(`unknown agent "${a}" (known: ${known.join(", ")})`);
    if (new Set(raw.agents).size !== raw.agents.length) errors.push(`"agents" lists an agent twice`);
    agents = raw.agents.filter((a) => known.includes(a));
  }

  const def = raw.default ?? agents[0];
  if (raw.default !== undefined && !agents.includes(raw.default)) errors.push(`"default" must be one of "agents"`);

  for (const key of ["allowSwitch", "sandbox", "webTools"]) {
    if (raw[key] !== undefined && !isBool(raw[key])) errors.push(`"${key}" must be true or false`);
  }
  if (raw.terminal !== undefined && !TERMINAL.includes(raw.terminal)) {
    errors.push(`"terminal" must be one of: ${TERMINAL.join(", ")}`);
  }
  if (raw.terminal === "sandboxed" && raw.sandbox === false) {
    errors.push(`"terminal": "sandboxed" needs "sandbox": true`);
  }

  const models = {};
  const rawModels = raw.models ?? {};
  if (typeof rawModels !== "object" || Array.isArray(rawModels)) {
    errors.push(`"models" must be an object keyed by agent`);
  } else {
    for (const key of Object.keys(rawModels)) {
      if (!agents.includes(key)) errors.push(`"models.${key}" is set but "${key}" is not in "agents"`);
    }
    for (const agent of agents) {
      const pin = pins.engines[pins.agents[agent]];
      const entry = rawModels[agent] ?? {};
      const allowed = entry.allowed ?? pin.models;
      if (!isStringArray(allowed) || allowed.length === 0) {
        errors.push(`"models.${agent}.allowed" must be a non-empty array`);
        continue;
      }
      for (const m of allowed) {
        if (!pin.models.includes(m)) errors.push(`"models.${agent}.allowed": "${m}" is not a pinned model (pinned: ${pin.models.join(", ")})`);
      }
      for (const key of Object.keys(entry)) {
        if (key !== "allowed" && key !== "default") errors.push(`unknown key "models.${agent}.${key}"`);
      }
      const fallback = allowed.includes(pin.default) ? pin.default : allowed[0];
      const chosen = entry.default ?? fallback;
      if (!allowed.includes(chosen)) errors.push(`"models.${agent}.default" must be in "models.${agent}.allowed"`);
      models[agent] = { allowed: [...new Set(allowed)], default: chosen };
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      agents,
      default: def,
      allowSwitch: agents.length > 1 && raw.allowSwitch === true,
      terminal: raw.terminal ?? "off",
      sandbox: raw.sandbox ?? true,
      webTools: raw.webTools ?? false,
      models,
    },
  };
}

/** The engine behind an agent, e.g. "opencosmo" -> "opencode". */
export const engineOf = (agent, pins = PINS) => pins.agents[agent];
