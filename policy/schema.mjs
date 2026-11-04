// Validation for the task's agent-sim.json. Every problem is reported at once, so a task
// author fixes a config in one round trip. A task can only narrow what pins.json allows.
import PINS from "./pins.json" with { type: "json" };

export { PINS };

const KEYS = new Set(["agents", "default", "allowSwitch", "terminal", "sandbox", "webTools", "models", "permissions", "instructions", "app"]);
const MAX_INSTRUCTIONS = 16_000;
// Ports the simulation itself uses (the shell, then the engines), so never the candidate's app.
export const RESERVED_PORTS = [3000, 4096, 4500, 4600];
// Where the candidate's app shows in the simulation's App pane (its dev server's base path).
export const APP_PATH = "/app/";
const TERMINAL = ["off", "sandboxed"];
// "ask" (the default): approve every edit and shell command; "engine-default": each engine's
// own out-of-the-box behaviour; "allow": no approval prompts.
export const PERMISSION_PRESETS = ["engine-default", "ask", "allow"];
const ACTIONS = ["ask", "allow", "deny"];
const MAX_BASH_PATTERNS = 50;

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

  const permissions = validatePermissions(raw.permissions, agents, errors);
  // Standing instructions every agent gets, as a user-level instructions layer would give them.
  if (raw.instructions !== undefined && (typeof raw.instructions !== "string" || raw.instructions.length > MAX_INSTRUCTIONS)) {
    errors.push(`"instructions" must be text of at most ${MAX_INSTRUCTIONS} characters`);
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
        if (!MODEL_KEYS.includes(key)) errors.push(`unknown key "models.${agent}.${key}"`);
      }
      const fallback = allowed.includes(pin.default) ? pin.default : allowed[0];
      const chosen = entry.default ?? fallback;
      if (!allowed.includes(chosen)) errors.push(`"models.${agent}.default" must be in "models.${agent}.allowed"`);
      const unique = [...new Set(allowed)];
      models[agent] = {
        allowed: unique,
        default: chosen,
        ...validateEfforts(entry, pin.efforts, `models.${agent}`, errors),
        ...validateNames(entry.names, unique, `models.${agent}.names`, errors),
      };
    }
  }

  const app = validateApp(raw.app, errors);

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
      permissions,
      ...(typeof raw.instructions === "string" && raw.instructions.trim() ? { instructions: raw.instructions.trim() } : {}),
      ...(app ? { app } : {}),
    },
  };
}

/**
 * `app`: { port } — the task has its own web app (for example a Vite dev server with base "/app/")
 * listening on this port. The preview stays the simulation's; its App pane shows the app.
 */
function validateApp(raw, errors) {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`"app" must be an object like { "port": 5173 }`);
    return null;
  }
  for (const key of Object.keys(raw)) if (key !== "port" && key !== "path") errors.push(`unknown key "app.${key}"`);
  // The path is fixed; a normalized config (as the server re-reads it) carries it.
  if (raw.path !== undefined && raw.path !== APP_PATH) errors.push(`"app.path" is always "${APP_PATH}"`);
  const { port } = raw;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    errors.push(`"app.port" must be a whole number from 1024 to 65535`);
    return null;
  }
  if (RESERVED_PORTS.includes(port)) {
    errors.push(`"app.port" ${port} is the simulation's own (reserved: ${RESERVED_PORTS.join(", ")})`);
    return null;
  }
  return { port, path: APP_PATH };
}

/**
 * `permissions`: { preset, edit?, bash?, auto? }. `edit` is one action; `bash` is one action or an
 * object of command patterns ("*" wildcards, later patterns win) to actions. `auto` (default
 * true) lets the candidate switch each agent to its auto mode, as the originals do: Cosmo Code's
 * Auto (a classifier decides), Cosmodex's "Approve for me" (a review agent decides) and
 * OpenCosmo's auto-accept. Sessions still start asking.
 */
function validatePermissions(raw, agents, errors) {
  if (raw === undefined) return { preset: "ask", auto: true };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`"permissions" must be an object`);
    return { preset: "ask", auto: true };
  }
  for (const key of Object.keys(raw)) {
    if (!["preset", "edit", "bash", "auto"].includes(key)) errors.push(`unknown key "permissions.${key}"`);
  }
  const preset = raw.preset ?? "ask";
  if (!PERMISSION_PRESETS.includes(preset)) errors.push(`"permissions.preset" must be one of: ${PERMISSION_PRESETS.join(", ")}`);
  if (raw.auto !== undefined && typeof raw.auto !== "boolean") errors.push(`"permissions.auto" must be true or false`);
  const out = { preset, auto: raw.auto ?? true };
  if (raw.edit !== undefined) {
    if (!ACTIONS.includes(raw.edit)) errors.push(`"permissions.edit" must be one of: ${ACTIONS.join(", ")}`);
    else out.edit = raw.edit;
  }
  if (raw.bash !== undefined) {
    if (typeof raw.bash === "string") {
      if (!ACTIONS.includes(raw.bash)) errors.push(`"permissions.bash" must be one of: ${ACTIONS.join(", ")}, or an object of patterns`);
      else out.bash = raw.bash;
    } else if (raw.bash && typeof raw.bash === "object" && !Array.isArray(raw.bash)) {
      const entries = Object.entries(raw.bash);
      if (entries.length === 0 || entries.length > MAX_BASH_PATTERNS) errors.push(`"permissions.bash" needs 1 to ${MAX_BASH_PATTERNS} patterns`);
      for (const [pattern, action] of entries) {
        if (!pattern.trim() || pattern.length > 200) errors.push(`"permissions.bash" pattern "${pattern.slice(0, 40)}" must be 1 to 200 characters`);
        if (!ACTIONS.includes(action)) errors.push(`"permissions.bash.${pattern}" must be one of: ${ACTIONS.join(", ")}`);
      }
      out.bash = Object.fromEntries(entries);
    } else {
      errors.push(`"permissions.bash" must be one of: ${ACTIONS.join(", ")}, or an object of patterns`);
    }
  }
  // Codex approves by policy, not per tool or command, so an override couldn't be honoured
  // there (and a "deny" would silently not apply).
  if (agents.includes("cosmodex") && (out.edit || out.bash)) {
    errors.push(`"permissions.edit" and "permissions.bash" can't be applied to cosmodex; use "permissions.preset" only`);
  }
  return out;
}

const MODEL_KEYS = ["allowed", "default", "efforts", "effort", "names"];

/**
 * `efforts`: the effort levels the candidate may pick (the engine's own names; all by default);
 * `effort`: the one sessions start with (the engine's default if unset).
 */
function validateEfforts(entry, known, at, errors) {
  const efforts = entry.efforts ?? known;
  if (!isStringArray(efforts) || efforts.length === 0) {
    errors.push(`"${at}.efforts" must be a non-empty array of: ${known.join(", ")}`);
    return { efforts: known };
  }
  for (const e of efforts) if (!known.includes(e)) errors.push(`"${at}.efforts": "${e}" is not an effort level here (known: ${known.join(", ")})`);
  if (entry.effort !== undefined && !efforts.includes(entry.effort)) errors.push(`"${at}.effort" must be in "${at}.efforts"`);
  return { efforts: known.filter((e) => efforts.includes(e)), ...(entry.effort !== undefined ? { effort: entry.effort } : {}) };
}

/** Names the candidate sees instead of the models' own, in the order of "allowed". */
export const COSMIC_NAMES = ["Orbit", "Nova", "Comet", "Nebula", "Pulsar", "Quasar", "Zenith", "Aurora"];

/**
 * `names`: true gives every allowed model a cosmic name; an object names them one by one (models it
 * leaves out get the next free cosmic name). Unset, candidates see the models' own names.
 */
function validateNames(raw, allowed, at, errors) {
  if (raw === undefined || raw === false) return {};
  if (raw !== true && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    errors.push(`"${at}" must be true or an object of model to name`);
    return {};
  }
  const given = raw === true ? {} : raw;
  for (const [model, name] of Object.entries(given)) {
    if (!allowed.includes(model)) errors.push(`"${at}": "${model}" is not in the allowed models`);
    if (typeof name !== "string" || !name.trim() || name.length > 40) errors.push(`"${at}.${model}" must be a name of 1 to 40 characters`);
  }
  const taken = new Set(Object.values(given));
  if (taken.size !== Object.keys(given).length) errors.push(`"${at}" gives two models the same name`);
  const free = COSMIC_NAMES.filter((n) => !taken.has(n));
  return { names: Object.fromEntries(allowed.map((m) => [m, given[m] ?? free.shift() ?? m])) };
}

/** The engine behind an agent, e.g. "opencosmo" -> "opencode". */
export const engineOf = (agent, pins = PINS) => pins.agents[agent];
