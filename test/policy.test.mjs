import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskConfig, PINS } from "../policy/schema.mjs";
import { renderPolicy, renderUserPolicy, RenderError, codexCatalog, anthropicBaseUrl, ROOT } from "../policy/render.mjs";
import { toToml, toTomlOverrides } from "../policy/toml.mjs";

const ENV = { OPENAI_BASE_URL: "https://proxy.test/v1", ANTHROPIC_BASE_URL: "https://proxy.test" };
const CATALOG = {
  models: PINS.engines.codex.models.map((slug) => ({ slug, supported_in_api: true, visibility: "hide", upgrade: "x" })),
};
const valid = (raw) => {
  const r = validateTaskConfig(raw);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.config;
};
const file = (rendered, p) => rendered.files.find((f) => f.path === p)?.content;

test("defaults: first agent, no switching, terminal off, sandbox on, pinned models", () => {
  const c = valid({ agents: ["cosmodex"] });
  assert.equal(c.default, "cosmodex");
  assert.equal(c.allowSwitch, false);
  assert.equal(c.terminal, "off");
  assert.equal(c.sandbox, true);
  assert.equal(c.webTools, false);
  assert.deepEqual(c.models.cosmodex, { allowed: PINS.engines.codex.models, default: PINS.engines.codex.default });
});

test("allowSwitch only means something with more than one agent", () => {
  assert.equal(valid({ agents: ["cosmodex"], allowSwitch: true }).allowSwitch, false);
  assert.equal(valid({ agents: ["cosmodex", "cosmo-code"], allowSwitch: true }).allowSwitch, true);
});

test("a task can narrow the pinned models but never add one", () => {
  const c = valid({ agents: ["cosmo-code"], models: { "cosmo-code": { allowed: ["claude-haiku-5-5"] } } });
  assert.deepEqual(c.models["cosmo-code"], { allowed: ["claude-haiku-5-5"], default: "claude-haiku-5-5" });
  const r = validateTaskConfig({ agents: ["cosmo-code"], models: { "cosmo-code": { allowed: ["claude-opus-5-5"] } } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /claude-opus-5-5" is not a pinned model/);
});

test("every problem is reported at once", () => {
  const r = validateTaskConfig({ agents: ["nope", "cosmodex"], default: "cosmo-code", terminal: "full", extra: 1, sandbox: "yes" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 5, r.errors.join("\n"));
});

test("a sandboxed terminal needs the sandbox", () => {
  const r = validateTaskConfig({ agents: ["cosmodex"], terminal: "sandboxed", sandbox: false });
  assert.equal(r.ok, false);
});

test("models for an agent that is not enabled are rejected", () => {
  const r = validateTaskConfig({ agents: ["cosmodex"], models: { opencosmo: { allowed: ["openai/gpt-6-luna"] } } });
  assert.equal(r.ok, false);
});

test("Anthropic base URL follows OpenCode's /v1 convention", () => {
  assert.equal(anthropicBaseUrl("https://p.test/"), "https://p.test/v1");
  assert.equal(anthropicBaseUrl("https://p.test/v1"), "https://p.test/v1");
  assert.equal(anthropicBaseUrl(""), null);
});

test("OpenCode policy: providers and whitelists from the allowed models, web tools denied", () => {
  const c = valid({ agents: ["opencosmo"], models: { opencosmo: { allowed: ["openai/gpt-5.6-terra"] } } });
  const doc = JSON.parse(file(renderPolicy(c, ENV), ROOT.opencode));
  assert.deepEqual(doc.enabled_providers, ["openai"]);
  assert.deepEqual(doc.provider.openai.whitelist, ["gpt-5.6-terra"]);
  assert.equal(doc.provider.openai.options.baseURL, ENV.OPENAI_BASE_URL);
  assert.equal(doc.model, "openai/gpt-5.6-terra");
  assert.equal(doc.permission.webfetch, "deny");
  assert.equal(doc.permission.external_directory, "deny");
  assert.equal(doc.share, "disabled");
  assert.equal(doc.autoupdate, false);
  assert.deepEqual(doc.mcp, {});
});

test("OpenCode runs from a root-owned config home with project config disabled", () => {
  const out = renderPolicy(valid({ agents: ["opencosmo"] }), ENV, { opencodeInstructions: "# Working agreement\n" });
  const env = JSON.parse(file(out, ROOT.engineEnv)).opencode;
  assert.equal(env.XDG_CONFIG_HOME, ROOT.xdg);
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(file(out, `${ROOT.xdg}/opencode/AGENTS.md`), "# Working agreement\n");
});

test("a provider without its proxy URL fails rendering (no silent bypass)", () => {
  const c = valid({ agents: ["opencosmo", "cosmodex"] });
  assert.throws(() => renderPolicy(c, {}, { codexBundledCatalog: CATALOG }), (e) => {
    assert.ok(e instanceof RenderError);
    assert.match(e.errors.join(), /ANTHROPIC_BASE_URL/);
    assert.match(e.errors.join(), /OPENAI_BASE_URL/);
    return true;
  });
});

test("Codex requirements pin provider, approvals, sandbox, search and login", () => {
  const c = valid({ agents: ["cosmodex"], models: { cosmodex: { allowed: ["gpt-5.6-terra"] } } });
  const toml = file(renderPolicy(c, ENV, { codexBundledCatalog: CATALOG }), ROOT.codexRequirements);
  assert.match(toml, /^allowed_approval_policies = \["untrusted"\]$/m); // the default "ask" preset
  assert.match(toml, /^allowed_sandbox_modes = \["read-only", "workspace-write"\]$/m);
  assert.match(toml, /^allowed_web_search_modes = \["disabled"\]$/m);
  assert.match(toml, /^allowed_login_methods = \["api"\]$/m);
  assert.match(toml, /^model_provider = "proxy"$/m);
  assert.match(toml, /^\[model_providers\.proxy\]$/m);
  assert.match(toml, /^base_url = "https:\/\/proxy\.test\/v1"$/m);
});

test("Codex catalog keeps only the task's models, default first, all listed", () => {
  const c = valid({ agents: ["cosmodex"], models: { cosmodex: { allowed: ["gpt-6-luna", "gpt-5.6-terra"], default: "gpt-5.6-terra" } } });
  const errors = [];
  const cat = codexCatalog(CATALOG, c, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(cat.models.map((m) => m.slug), ["gpt-5.6-terra", "gpt-6-luna"]);
  assert.ok(cat.models.every((m) => m.visibility === "list" && m.upgrade === null));
  const missing = [];
  codexCatalog({ models: [] }, c, missing);
  assert.equal(missing.length, 2);
});

test("Claude managed settings: model ceiling, no bypass, managed-only MCP/hooks/rules, sandbox", () => {
  const c = valid({ agents: ["cosmo-code"], models: { "cosmo-code": { allowed: ["claude-sonnet-5-5"] } } });
  const s = JSON.parse(file(renderPolicy(c, ENV), ROOT.claude));
  assert.deepEqual(s.availableModels, ["claude-sonnet-5-5"]);
  assert.equal(s.enforceAvailableModels, true);
  assert.equal(s.permissions.disableBypassPermissionsMode, "disable");
  assert.equal(s.permissions.defaultMode, "default"); // the default preset asks, so sessions start in Manual
  assert.deepEqual(s.permissions.deny, ["WebSearch", "WebFetch"]);
  assert.equal(s.allowManagedMcpServersOnly, true);
  assert.deepEqual(s.allowedMcpServers, []);
  assert.equal(s.allowManagedHooksOnly, true);
  assert.equal(s.allowManagedPermissionRulesOnly, true);
  // The default preset asks before Bash, so sandboxed commands mustn't be approved silently.
  assert.deepEqual(s.sandbox, {
    enabled: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    network: { allowManagedDomainsOnly: true, allowedDomains: [] },
  });
  assert.equal(JSON.parse(file(renderPolicy(valid({ ...c, webTools: true }), ENV), ROOT.claude)).sandbox.network, undefined);
  const open = JSON.parse(file(renderPolicy(valid({ ...c, permissions: { preset: "allow" } }), ENV), ROOT.claude));
  assert.equal(open.sandbox.autoAllowBashIfSandboxed, true);
  assert.equal(JSON.parse(file(renderPolicy({ ...c, sandbox: false }, ENV), ROOT.claude)).sandbox, undefined);
});

test("only enabled engines get policy files; keys never appear in any file", () => {
  const c = valid({ agents: ["cosmo-code"] });
  const out = renderPolicy(c, { ...ENV, OPENAI_API_KEY: "sk-secret", ANTHROPIC_API_KEY: "sk-secret" });
  const paths = out.files.map((f) => f.path);
  assert.ok(!paths.includes(ROOT.opencode) && !paths.includes(ROOT.codexRequirements));
  assert.ok(out.files.every((f) => !f.content.includes("sk-secret")));
});

test("toml writer: scalars first, nested tables, quoting", () => {
  assert.equal(toToml({ a: "x", b: true, c: ["1", "2"], t: { "k.y": { n: 1 } } }), 'a = "x"\nb = true\nc = ["1", "2"]\n\n[t."k.y"]\nn = 1');
});

test("permissions default to asking before every edit and shell command", () => {
  assert.deepEqual(valid({ agents: ["opencosmo"] }).permissions, { preset: "ask" });
  assert.deepEqual(valid({ agents: ["opencosmo"], permissions: {} }).permissions, { preset: "ask" });
  const doc = JSON.parse(file(renderPolicy(valid({ agents: ["opencosmo"] }), ENV), ROOT.opencode));
  assert.equal(doc.permission.edit, "ask");
  assert.equal(doc.permission.bash, "ask");
});

test("engine-default leaves edits and commands to the engine", () => {
  const doc = JSON.parse(file(renderPolicy(valid({ agents: ["opencosmo"], permissions: { preset: "engine-default" } }), ENV), ROOT.opencode));
  assert.equal(doc.permission.edit, undefined);
  assert.equal(doc.permission.bash, undefined);
});

test("permissions: preset, overrides and patterns are validated together", () => {
  const r = validateTaskConfig({ agents: ["opencosmo"], permissions: { preset: "sometimes", edit: "maybe", bash: { "": "ask", "rm *": "nope" }, x: 1 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 5, r.errors.join("\n"));
});

test("Cosmodex takes a preset only (a per-command deny could not be honoured there)", () => {
  const r = validateTaskConfig({ agents: ["opencosmo", "cosmodex"], permissions: { preset: "ask", bash: { "rm *": "deny" } } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /cosmodex/);
  assert.equal(valid({ agents: ["cosmodex"], permissions: { preset: "ask" } }).permissions.preset, "ask");
});

test("OpenCode: the ask preset prompts for edits and commands; overrides and patterns keep their order", () => {
  const ask = JSON.parse(file(renderPolicy(valid({ agents: ["opencosmo"], permissions: { preset: "ask" } }), ENV), ROOT.opencode));
  assert.equal(ask.permission.edit, "ask");
  assert.equal(ask.permission.bash, "ask");
  assert.equal(ask.permission.external_directory, "deny");
  assert.equal(ask.permission.webfetch, "deny");
  const custom = valid({ agents: ["opencosmo"], permissions: { preset: "allow", bash: { "*": "ask", "git status*": "allow", "rm *": "deny" } } });
  const doc = JSON.parse(file(renderPolicy(custom, ENV), ROOT.opencode));
  assert.equal(doc.permission.edit, "allow");
  assert.deepEqual(Object.entries(doc.permission.bash), [["*", "ask"], ["git status*", "allow"], ["rm *", "deny"]]);
});

const claudeRules = (permissions) => JSON.parse(file(renderPolicy(valid({ agents: ["cosmo-code"], permissions }), ENV), ROOT.claude)).permissions;

test("Claude Code: ask preset lists edits and Bash under ask; allow preset under allow", () => {
  const ask = claudeRules({ preset: "ask" });
  assert.deepEqual(ask.ask, ["Edit", "Write", "NotebookEdit", "Bash"]);
  assert.deepEqual(ask.allow, []);
  assert.deepEqual(claudeRules({ preset: "allow" }).allow, ["Edit", "Write", "NotebookEdit", "Bash"]);
  assert.deepEqual(claudeRules({}).ask, ["Edit", "Write", "NotebookEdit", "Bash"]);
  assert.deepEqual(claudeRules({ preset: "engine-default" }).ask, []);
});

test("Claude Code: an allowed command under 'ask everything' relies on the default mode, not a Bash ask rule", () => {
  const r = claudeRules({ preset: "ask", bash: { "*": "ask", "git status*": "allow" } });
  assert.ok(!r.ask.includes("Bash"));
  assert.deepEqual(r.allow, ["Bash(git status*)"]);
  const r2 = claudeRules({ preset: "allow", bash: { "*": "allow", "rm *": "ask", "curl *": "deny" } });
  assert.ok(r2.allow.includes("Bash"));
  assert.deepEqual(r2.ask, ["Bash(rm *)"]);
  assert.ok(r2.deny.includes("Bash(curl *)"));
  assert.throws(() => renderPolicy(valid({ agents: ["cosmo-code"], permissions: { bash: { "*": "deny", "ls*": "allow" } } }), ENV), RenderError);
});

test("Codex: presets map to approval policies", () => {
  const policy = (preset) => file(renderPolicy(valid({ agents: ["cosmodex"], permissions: { preset } }), ENV, { codexBundledCatalog: CATALOG }), ROOT.codexRequirements).match(/^allowed_approval_policies = .*$/m)[0];
  assert.equal(policy("engine-default"), 'allowed_approval_policies = ["on-request"]');
  assert.equal(policy("ask"), 'allowed_approval_policies = ["untrusted"]');
  assert.equal(policy("allow"), 'allowed_approval_policies = ["never"]');
});

test("user mode: each engine's policy as environment or arguments, nothing on disk", () => {
  const c = valid({ agents: ["opencosmo", "cosmodex", "cosmo-code"], models: { opencosmo: { allowed: ["anthropic/claude-sonnet-5-5"] } } });
  const out = renderUserPolicy(c, ENV, { codexBundledCatalog: CATALOG }, { catalogPath: "/home/runner/.cosmo-agents/state/codex-models.json" });
  // OpenCode: the same config as root mode, inline; project config still off.
  const oc = JSON.parse(out.engineEnv.opencode.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(oc.enabled_providers, ["anthropic"]);
  assert.equal(oc.permission.external_directory, "deny");
  assert.equal(out.engineEnv.opencode.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(out.engineEnv.opencode.XDG_CONFIG_HOME, undefined);
  // Codex: the proxy and the narrowed catalog as -c overrides; requirements keys don't apply.
  assert.ok(out.codexArgs.includes('model_provider="proxy"'));
  assert.ok(out.codexArgs.includes('model_providers.proxy.base_url="https://proxy.test/v1"'));
  assert.ok(out.codexArgs.includes('model_catalog_json="/home/runner/.cosmo-agents/state/codex-models.json"'));
  assert.ok(!out.codexArgs.some((a) => a.startsWith("allowed_")));
  assert.deepEqual(out.codexCatalog.models.map((m) => m.slug), c.models.cosmodex.allowed);
  // Cosmo Code: the managed settings without "managed rules only" (policy-tier allow rules are
  // dropped, so the task's allow rules come through the flag tier).
  const cc = JSON.parse(out.engineEnv.claude.COSMO_CODE_SETTINGS);
  assert.equal(cc.allowManagedPermissionRulesOnly, undefined);
  assert.equal(cc.allowManagedMcpServersOnly, true);
  assert.deepEqual(cc.availableModels, c.models["cosmo-code"].allowed);
  assert.equal(cc.permissions.disableBypassPermissionsMode, "disable");
});

test("user mode: a missing proxy route still fails", () => {
  assert.throws(() => renderUserPolicy(valid({ agents: ["cosmodex"] }), {}, { codexBundledCatalog: CATALOG }, { catalogPath: "/x" }), RenderError);
});

test("-c overrides: one per leaf, dotted keys, TOML values", () => {
  assert.deepEqual(toTomlOverrides({ a: "x", b: { c: true, d: ["y"] } }), ['a="x"', "b.c=true", 'b.d=["y"]']);
});
