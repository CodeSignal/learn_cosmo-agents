// Turns a validated task config into the root-owned files each engine treats as final.
// Pure: no filesystem access, so every rule is unit-testable. root/apply-policy.mjs writes
// the result.
import { PINS, engineOf } from "./schema.mjs";
import { toToml, toTomlOverrides } from "./toml.mjs";

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
  const asked = opencodePermissions(config.permissions);
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    enabled_providers: Object.keys(whitelist),
    model,
    small_model: model,
    provider,
    permission: { ...asked, ...deny, external_directory: "deny" },
    mcp: {},
  };
}

const PRESET_ACTION = { ask: "ask", allow: "allow" };

/** OpenCode `permission` entries for edits and shell commands (later bash patterns win). */
export function opencodePermissions({ preset, edit, bash }) {
  const out = {};
  const base = PRESET_ACTION[preset];
  if (edit ?? base) out.edit = edit ?? base;
  if (bash ?? base) out.bash = bash ?? base;
  return out;
}

const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

/**
 * Claude Code rule lists for edits and shell commands. Claude applies deny, then ask, then allow
 * whatever the order, and its default mode already asks before edits and commands, so "ask" for
 * everything is expressed by leaving the rule out when an allow exception needs to win.
 */
export function claudePermissions({ preset, edit, bash }, errors) {
  const lists = { allow: [], ask: [], deny: [] };
  const base = PRESET_ACTION[preset];
  const editAction = edit ?? base;
  if (editAction) lists[editAction].push(...EDIT_TOOLS);
  const bashRules = typeof bash === "object" ? bash : { "*": bash ?? base };
  const all = bashRules["*"];
  const exceptions = Object.entries(bashRules).filter(([p]) => p !== "*");
  if (all === "deny" && exceptions.some(([, a]) => a !== "deny")) {
    errors.push(`cosmo-code can't allow or ask for some commands when "permissions.bash" "*" is "deny"`);
  }
  if (all === "deny" || all === "allow" || (all === "ask" && !exceptions.some(([, a]) => a === "allow"))) {
    lists[all].push("Bash");
  }
  for (const [pattern, action] of exceptions) lists[action].push(`Bash(${pattern})`);
  return lists;
}

/** Codex approval policies a preset allows: on-request is Codex's own default. */
const CODEX_APPROVAL = { "engine-default": ["on-request"], ask: ["untrusted"], allow: ["never"] };

/** What Codex may be asked for under this task: the requirements file and the gateway share it. */
export function codexCeilings(config) {
  return {
    models: config.models.cosmodex?.allowed ?? [],
    approvalPolicies: CODEX_APPROVAL[config.permissions.preset],
    sandboxModes: config.sandbox ? ["read-only", "workspace-write"] : ["read-only", "workspace-write", "danger-full-access"],
    webSearchModes: config.webTools ? ["disabled", "cached", "live"] : ["disabled"],
  };
}

/**
 * What Cosmo Code may be asked for: models from the allowlist, and the permission modes a
 * candidate can pick (never bypass; the managed settings disable it too). The ask rules still
 * apply in every mode, so "Accept edits" can't skip a prompt the task wants.
 */
export function claudeCeilings(config) {
  const asks = config.permissions.preset === "ask";
  return {
    models: config.models["cosmo-code"]?.allowed ?? [],
    modes: ["default", "acceptEdits", "plan"],
    defaultMode: asks ? "default" : "acceptEdits",
    webTools: !!config.webTools,
  };
}

/** Codex configuration (not requirements): the proxy as the only provider and the narrowed catalog. */
function codexConfig(env, catalogPath, errors) {
  const baseUrl = (env.OPENAI_BASE_URL || "").trim();
  if (!baseUrl) errors.push("cosmodex is enabled but OPENAI_BASE_URL is not set");
  return {
    check_for_update_on_startup: false,
    model_provider: CODEX_PROVIDER,
    model_catalog_json: catalogPath,
    model_providers: {
      [CODEX_PROVIDER]: { name: "LLM proxy", base_url: baseUrl, env_key: "OPENAI_API_KEY", wire_api: "responses" },
    },
  };
}

function codexRequirements(config, env, errors) {
  return {
    allowed_approval_policies: codexCeilings(config).approvalPolicies,
    allowed_sandbox_modes: codexCeilings(config).sandboxModes,
    allowed_web_search_modes: codexCeilings(config).webSearchModes,
    allowed_login_methods: ["api"],
    allow_remote_control: false,
    allow_browser_and_computer_use: false,
    allow_managed_hooks_only: true,
    ...codexConfig(env, ROOT.codexCatalog, errors),
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

function claude(config, errors) {
  const { allowed, default: model } = config.models["cosmo-code"];
  const rules = claudePermissions(config.permissions, errors);
  const settings = {
    model,
    availableModels: allowed,
    enforceAvailableModels: true,
    permissions: {
      allow: rules.allow,
      ask: rules.ask,
      deny: [...rules.deny, ...(config.webTools ? [] : ["WebSearch", "WebFetch"])],
      defaultMode: claudeCeilings(config).defaultMode,
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
    // Sandboxed commands would otherwise run without asking, whatever the ask rules say.
    const asksForBash = rules.ask.some((r) => r === "Bash" || r.startsWith("Bash("));
    settings.sandbox = { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: !asksForBash };
    // Without web tools no host is reachable from the sandbox, and the engine doesn't even ask
    // (the candidate could otherwise approve a host); user and project settings can't add any.
    if (!config.webTools) settings.sandbox.network = { allowManagedDomainsOnly: true, allowedDomains: [] };
  }
  return settings;
}

const OPENCODE_ENV = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
};
const CLAUDE_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };

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
    engineEnv.opencode = { XDG_CONFIG_HOME: ROOT.xdg, ...OPENCODE_ENV };
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
    files.push({ path: ROOT.claude, content: json(claude(config, errors)) });
    engineEnv.claude = { ...CLAUDE_ENV };
  }

  files.push({ path: ROOT.engineEnv, content: json(engineEnv) });
  files.push({ path: ROOT.policy, content: json(config) });
  if (errors.length) throw new RenderError(errors);
  return { dirs, files };
}

/**
 * The same policy for a session without root (a platform image where setup runs as the session
 * user). Nothing can be written where an engine treats it as final, so each engine gets its
 * policy from the process that starts it, which holds it in memory: OpenCode as inline config,
 * Codex as `-c` overrides, Cosmo Code's engine host as SDK policy-tier settings. Files the session
 * user can edit (user-level and project config) still load, as with any user-level provisioning;
 * the gateways enforce every ceiling regardless.
 *
 * @param catalogPath  where the caller writes `codexCatalog` (Codex reads its catalog from a file)
 * @returns {{ engineEnv: object, codexArgs: string[], codexCatalog: object|null }}
 */
export function renderUserPolicy(config, env = {}, inputs = {}, { catalogPath } = {}, pins = PINS) {
  const errors = [];
  const engineEnv = {};
  let codexArgs = [];
  let catalog = null;
  const engines = new Set(config.agents.map((a) => engineOf(a, pins)));
  if (engines.has("opencode")) {
    engineEnv.opencode = { OPENCODE_CONFIG_CONTENT: JSON.stringify(opencode(config, env, errors)), ...OPENCODE_ENV };
  }
  if (engines.has("codex")) {
    catalog = codexCatalog(inputs.codexBundledCatalog, config, errors);
    // The approval policy can't be configured here ("untrusted" only comes from requirements): the
    // gateway sets the task's on every new thread.
    codexArgs = toTomlOverrides(codexConfig(env, catalogPath, errors)).flatMap((o) => ["-c", o]);
    engineEnv.codex = {};
  }
  if (engines.has("claude")) {
    // Policy-tier settings from a parent process keep only restrictive keys, and "managed rules
    // only" would then drop the task's allow rules too; the host also passes these as flag
    // settings, which carry the model and the allow rules.
    const settings = claude(config, errors);
    delete settings.allowManagedPermissionRulesOnly;
    engineEnv.claude = { ...CLAUDE_ENV, COSMO_CODE_SETTINGS: JSON.stringify(settings) };
  }
  if (errors.length) throw new RenderError(errors);
  return { engineEnv, codexArgs, codexCatalog: catalog };
}
