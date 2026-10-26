// Turns a validated task config into the root-owned files each engine treats as final.
// Pure: no filesystem access, so every rule is unit-testable. root/apply-policy.mjs writes
// the result.
import { PINS, engineOf } from "./schema.mjs";
import { toToml } from "./toml.mjs";

export const ROOT = {
  agentsim: "/etc/agentsim",
  policy: "/etc/agentsim/policy.json",
  engineEnv: "/etc/agentsim/engine-env.json",
  xdg: "/etc/agentsim/xdg",
  opencode: "/etc/opencode/opencode.json",
  codexRequirements: "/etc/codex/requirements.toml",
  codexCatalog: "/etc/codex/models.json",
  claude: "/etc/claude-code/managed-settings.json",
};

// The provider id written into Codex's config. Neutral on purpose: the requirement pins it.
const CODEX_PROVIDER = "proxy";

export class RenderError extends Error {
  constructor(errors) {
    super(errors.join("\n"));
    this.errors = errors;
  }
}

const json = (v) => JSON.stringify(v, null, 2) + "\n";

/** OpenCode's Anthropic base URL convention: no trailing slash, ends in /v1. */
export function anthropicBaseUrl(raw) {
  const s = (raw || "").trim().replace(/\/+$/, "");
  if (!s) return null;
  return s.endsWith("/v1") ? s : `${s}/v1`;
}

function opencode(config, env, errors) {
  const { allowed, default: model } = config.models.opencosmo;
  const whitelist = {};
  for (const id of allowed) {
    const [provider, ...rest] = id.split("/");
    (whitelist[provider] ??= []).push(rest.join("/"));
  }
  const provider = {};
  for (const [id, models] of Object.entries(whitelist)) {
    const baseURL = id === "anthropic" ? anthropicBaseUrl(env.ANTHROPIC_BASE_URL) : (env.OPENAI_BASE_URL || "").trim() || null;
    if (!baseURL) {
      errors.push(`opencosmo allows ${id}/* models but ${id === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"} is not set`);
    }
    provider[id] = { whitelist: models, options: { baseURL } };
  }
  const deny = config.webTools ? {} : { webfetch: "deny", websearch: "deny" };
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    enabled_providers: Object.keys(whitelist),
    model,
    small_model: model,
    provider,
    permission: { ...deny, external_directory: "deny" },
    mcp: {},
  };
}

function codexRequirements(config, env, errors) {
  const baseUrl = (env.OPENAI_BASE_URL || "").trim();
  if (!baseUrl) errors.push("cosmodex is enabled but OPENAI_BASE_URL is not set");
  return {
    allowed_approval_policies: ["on-request"],
    allowed_sandbox_modes: config.sandbox ? ["read-only", "workspace-write"] : ["read-only", "workspace-write", "danger-full-access"],
    allowed_web_search_modes: config.webTools ? ["disabled", "cached", "live"] : ["disabled"],
    allowed_login_methods: ["api"],
    allow_remote_control: false,
    allow_browser_and_computer_use: false,
    allow_managed_hooks_only: true,
    check_for_update_on_startup: false,
    model_provider: CODEX_PROVIDER,
    model_catalog_json: ROOT.codexCatalog,
    model_providers: {
      [CODEX_PROVIDER]: { name: "LLM proxy", base_url: baseUrl, env_key: "OPENAI_API_KEY", wire_api: "responses" },
    },
  };
}

/** Narrow Codex's bundled catalog (`codex debug models --bundled`) to the task's models. */
export function codexCatalog(bundled, config, errors) {
  const { allowed } = config.models.cosmodex;
  const entries = bundled?.models;
  if (!Array.isArray(entries)) {
    errors.push("Codex's bundled model catalog is missing or invalid");
    return null;
  }
  const bySlug = new Map(entries.filter((e) => e && typeof e.slug === "string").map((e) => [e.slug, e]));
  const selected = [];
  for (const slug of allowed) {
    const entry = bySlug.get(slug);
    if (!entry) errors.push(`Codex's bundled catalog lacks ${slug}`);
    else if (entry.supported_in_api !== true) errors.push(`Codex's bundled catalog does not offer ${slug} for API login`);
    else selected.push({ ...entry, visibility: "list", upgrade: null });
  }
  // The task default first, so the picker opens on it.
  selected.sort((a, b) => (b.slug === config.models.cosmodex.default) - (a.slug === config.models.cosmodex.default));
  return { ...bundled, models: selected };
}

function claude(config) {
  const { allowed, default: model } = config.models["cosmo-code"];
  const settings = {
    model,
    availableModels: allowed,
    enforceAvailableModels: true,
    permissions: {
      deny: config.webTools ? [] : ["WebSearch", "WebFetch"],
      disableBypassPermissionsMode: "disable",
    },
    allowManagedPermissionRulesOnly: true,
    allowManagedHooksOnly: true,
    allowManagedMcpServersOnly: true,
    allowedMcpServers: [],
    enableAllProjectMcpServers: false,
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
  };
  if (config.sandbox) {
    settings.sandbox = { enabled: true, allowUnsandboxedCommands: false };
  }
  return settings;
}

/**
 * @param config  validated task config
 * @param env     the proxy route: OPENAI_BASE_URL, ANTHROPIC_BASE_URL (keys never go into files)
 * @param inputs  { codexBundledCatalog?, opencodeInstructions? }
 * @returns {{ dirs: string[], files: {path: string, content: string}[] }}
 */
export function renderPolicy(config, env = {}, inputs = {}, pins = PINS) {
  const errors = [];
  const files = [];
  const dirs = [ROOT.agentsim];
  const engineEnv = {};
  const engines = new Set(config.agents.map((a) => engineOf(a, pins)));

  if (engines.has("opencode")) {
    dirs.push("/etc/opencode", ROOT.xdg, `${ROOT.xdg}/opencode`);
    files.push({ path: ROOT.opencode, content: json(opencode(config, env, errors)) });
    if (inputs.opencodeInstructions) {
      files.push({ path: `${ROOT.xdg}/opencode/AGENTS.md`, content: inputs.opencodeInstructions });
    }
    // A root-owned XDG_CONFIG_HOME and no project config: nothing the candidate can write
    // is loaded as OpenCode config (user-level allow rules otherwise beat managed denies).
    engineEnv.opencode = {
      XDG_CONFIG_HOME: ROOT.xdg,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    };
  }
  if (engines.has("codex")) {
    dirs.push("/etc/codex");
    files.push({ path: ROOT.codexRequirements, content: toToml(codexRequirements(config, env, errors)) + "\n" });
    const catalog = codexCatalog(inputs.codexBundledCatalog, config, errors);
    if (catalog) files.push({ path: ROOT.codexCatalog, content: json(catalog) });
    engineEnv.codex = {};
  }
  if (engines.has("claude")) {
    dirs.push("/etc/claude-code");
    files.push({ path: ROOT.claude, content: json(claude(config)) });
    engineEnv.claude = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
  }

  files.push({ path: ROOT.engineEnv, content: json(engineEnv) });
  files.push({ path: ROOT.policy, content: json(config) });
  if (errors.length) throw new RenderError(errors);
  return { dirs, files };
}
