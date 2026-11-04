import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskConfig, PINS } from "../policy/schema.mjs";
import { renderPolicy, renderUserPolicy, RenderError, codexCatalog, codexCeilings, anthropicBaseUrl, ROOT } from "../policy/render.mjs";
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
  assert.deepEqual(c.models.cosmodex, { allowed: PINS.engines.codex.models, default: PINS.engines.codex.default, efforts: PINS.engines.codex.efforts });
});

test("allowSwitch only means something with more than one agent", () => {
  assert.equal(valid({ agents: ["cosmodex"], allowSwitch: true }).allowSwitch, false);
  assert.equal(valid({ agents: ["cosmodex", "cosmo-code"], allowSwitch: true }).allowSwitch, true);
});

test("a task can narrow the pinned models but never add one", () => {
  const c = valid({ agents: ["cosmo-code"], models: { "cosmo-code": { allowed: ["claude-haiku-5-5"] } } });
  assert.deepEqual(c.models["cosmo-code"], { allowed: ["claude-haiku-5-5"], default: "claude-haiku-5-5", efforts: PINS.engines.claude.efforts });
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

test("OpenCode policy: a model newer than OpenCode's catalog comes with its definition", () => {
  const def = { name: "Claude Nova", reasoning: true, limit: { context: 1000000, output: 128000 } };
  const opencode = { ...PINS.engines.opencode, models: [...PINS.engines.opencode.models, "anthropic/claude-nova"], definitions: { "anthropic/claude-nova": def } };
  const pins = { ...PINS, engines: { ...PINS.engines, opencode } };
  const raw = { agents: ["opencosmo"], models: { opencosmo: { allowed: ["anthropic/claude-nova", "openai/gpt-6-luna"], efforts: ["low", "medium"] } } };
  const doc = JSON.parse(file(renderPolicy(validateTaskConfig(raw, pins).config, ENV, {}, pins), ROOT.opencode));
  const nova = doc.provider.anthropic.models["claude-nova"];
  assert.equal(nova.name, "Claude Nova");
  assert.deepEqual(nova.limit, def.limit);
  assert.equal(nova.variants.high.disabled, true);
  assert.equal(doc.provider.openai.models["gpt-6-luna"].name, undefined); // in the catalog already
});

test("OpenCode policy: with limited levels, Default is the task's starting level", () => {
  const limited = (extra) => valid({ agents: ["opencosmo"], models: { opencosmo: { allowed: ["anthropic/claude-haiku-5-5", "openai/gpt-6-luna"], efforts: ["low", "medium"], ...extra } } });
  const doc = JSON.parse(file(renderPolicy(limited({ effort: "medium" }), ENV), ROOT.opencode));
  assert.deepEqual(doc.provider.anthropic.models["claude-haiku-5-5"].options, { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" });
  assert.deepEqual(doc.provider.openai.models["gpt-6-luna"].options, { reasoningEffort: "medium" });
  assert.deepEqual(doc.agent.build, { model: "anthropic/claude-haiku-5-5", variant: "medium" });
  // Without a starting level, the lowest common one the task allows.
  assert.equal(JSON.parse(file(renderPolicy(limited({}), ENV), ROOT.opencode)).agent.plan.variant, "low");
  // All levels allowed: OpenCode's own defaults.
  const open = JSON.parse(file(renderPolicy(valid({ agents: ["opencosmo"] }), ENV), ROOT.opencode));
  assert.equal(open.agent, undefined);
  assert.equal(open.provider.anthropic.models, undefined);
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
  // The default "ask" preset, and on-request for "Approve for me" (auto mode is on by default).
  assert.match(toml, /^allowed_approval_policies = \["untrusted", "on-request"\]$/m);
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
  // Auto mode is offered, but sessions start asking.
  assert.deepEqual(valid({ agents: ["opencosmo"] }).permissions, { preset: "ask", auto: true });
  assert.deepEqual(valid({ agents: ["opencosmo"], permissions: {} }).permissions, { preset: "ask", auto: true });
  assert.equal(valid({ agents: ["opencosmo"], permissions: { auto: false } }).permissions.auto, false);
  assert.equal(validateTaskConfig({ agents: ["opencosmo"], permissions: { auto: "yes" } }).ok, false);
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

// The task's rules as written, without auto mode (which leaves the ask rules out; see below).
const claudeSettings = (permissions) => JSON.parse(file(renderPolicy(valid({ agents: ["cosmo-code"], permissions }), ENV), ROOT.claude));
const claudeRules = (permissions) => claudeSettings({ auto: false, ...permissions }).permissions;

test("Claude Code with auto mode: ask rules in the flag tier only (in the policy tier Auto would ask too)", () => {
  const c = valid({ agents: ["cosmo-code"], permissions: { preset: "ask" } });
  const env = renderUserPolicy(c, ENV).engineEnv.claude;
  assert.deepEqual(JSON.parse(env.COSMO_CODE_SETTINGS).permissions.ask, []);
  assert.deepEqual(JSON.parse(env.COSMO_CODE_FLAG_SETTINGS).permissions.ask, ["Edit", "Write", "NotebookEdit", "Bash"]);
  assert.equal(JSON.parse(env.COSMO_CODE_SETTINGS).disableAutoMode, undefined);
  const without = renderUserPolicy(valid({ agents: ["cosmo-code"], permissions: { preset: "ask", auto: false } }), ENV).engineEnv.claude;
  assert.deepEqual(JSON.parse(without.COSMO_CODE_SETTINGS).permissions.ask, ["Edit", "Write", "NotebookEdit", "Bash"]);
  assert.equal(JSON.parse(without.COSMO_CODE_SETTINGS).disableAutoMode, "disable");
  // Root mode reads rules from the managed file only: with auto mode, Manual is the engine's default.
  assert.deepEqual(claudeSettings({ preset: "ask" }).permissions.ask, []);
});

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
  const policy = (preset, auto = false) => file(renderPolicy(valid({ agents: ["cosmodex"], permissions: { preset, auto } }), ENV, { codexBundledCatalog: CATALOG }), ROOT.codexRequirements).match(/^allowed_approval_policies = .*$/m)[0];
  assert.equal(policy("engine-default"), 'allowed_approval_policies = ["on-request"]');
  assert.equal(policy("ask"), 'allowed_approval_policies = ["untrusted"]');
  assert.equal(policy("allow"), 'allowed_approval_policies = ["never"]');
  assert.equal(policy("ask", true), 'allowed_approval_policies = ["untrusted", "on-request"]');
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
  assert.ok(out.codexArgs.includes('sandbox_mode="workspace-write"'));
  assert.ok(!out.codexArgs.some((a) => a.startsWith("sandbox_workspace_write.")));
  assert.deepEqual(out.codexCatalog.models.map((m) => m.slug), c.models.cosmodex.allowed);
  // Cosmo Code: the managed settings without "managed rules only" (policy-tier allow rules are
  // dropped, so the task's allow rules come through the flag tier).
  const cc = JSON.parse(out.engineEnv.claude.COSMO_CODE_SETTINGS);
  assert.equal(cc.allowManagedPermissionRulesOnly, undefined);
  assert.equal(cc.allowManagedMcpServersOnly, true);
  assert.deepEqual(cc.availableModels, c.models["cosmo-code"].allowed);
  assert.equal(cc.permissions.disableBypassPermissionsMode, "disable");
});

test("user mode: without fresh /proc mounts, Cosmo Code's own command sandbox is off", () => {
  const c = valid({ agents: ["cosmo-code"] });
  const on = JSON.parse(renderUserPolicy(c, ENV).engineEnv.claude.COSMO_CODE_SETTINGS);
  const off = JSON.parse(renderUserPolicy(c, ENV, {}, { claudeSandbox: false }).engineEnv.claude.COSMO_CODE_SETTINGS);
  assert.equal(on.sandbox.enabled, true);
  assert.equal(off.sandbox, undefined);
});

test("user mode: a missing proxy route still fails", () => {
  assert.throws(() => renderUserPolicy(valid({ agents: ["cosmodex"] }), {}, { codexBundledCatalog: CATALOG }, { catalogPath: "/x" }), RenderError);
});

test("-c overrides: one per leaf, dotted keys, TOML values", () => {
  assert.deepEqual(toTomlOverrides({ a: "x", b: { c: true, d: ["y"] } }), ['a="x"', "b.c=true", 'b.d=["y"]']);
});

test("efforts: a subset of the engine's levels, in its order, with a starting level from them", () => {
  const m = valid({ agents: ["cosmo-code"], models: { "cosmo-code": { efforts: ["high", "low"], effort: "low" } } }).models["cosmo-code"];
  assert.deepEqual(m.efforts, ["low", "high"]);
  assert.equal(m.effort, "low");
  const bad = validateTaskConfig({ agents: ["cosmodex"], models: { cosmodex: { efforts: ["max"], effort: "low" } } });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
});

test("names: cosmic names on request, the task's own where it gives them, unique", () => {
  const auto = valid({ agents: ["cosmodex"], models: { cosmodex: { names: true } } }).models.cosmodex.names;
  assert.deepEqual(Object.values(auto), ["Orbit", "Nova", "Comet"]);
  const mixed = valid({ agents: ["cosmodex"], models: { cosmodex: { allowed: ["gpt-5.6-terra", "gpt-6-luna"], names: { "gpt-6-luna": "Orbit" } } } }).models.cosmodex.names;
  assert.deepEqual(mixed, { "gpt-5.6-terra": "Nova", "gpt-6-luna": "Orbit" });
  assert.equal(valid({ agents: ["cosmodex"] }).models.cosmodex.names, undefined);
  assert.equal(validateTaskConfig({ agents: ["cosmodex"], models: { cosmodex: { names: { "gpt-6-luna": "A", "gpt-6.1-sol": "A" } } } }).ok, false);
  assert.equal(validateTaskConfig({ agents: ["cosmodex"], models: { cosmodex: { allowed: ["gpt-6-luna"], names: { "gpt-6.1-sol": "A" } } } }).ok, false);
});

test("names and efforts reach the engines: OpenCode's config and Codex's catalog", () => {
  const c = valid({
    agents: ["opencosmo", "cosmodex"],
    models: {
      opencosmo: { allowed: ["anthropic/claude-sonnet-5-5"], efforts: ["low", "medium", "high"], names: true },
      cosmodex: { allowed: ["gpt-5.6-terra"], efforts: ["low", "medium"], effort: "low", names: { "gpt-5.6-terra": "Comet" } },
    },
  });
  const oc = JSON.parse(renderUserPolicy(c, ENV, { codexBundledCatalog: { models: [{ slug: "gpt-5.6-terra", supported_in_api: true, display_name: "GPT", description: "x", default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })) }] } }, { catalogPath: "/x" }).engineEnv.opencode.OPENCODE_CONFIG_CONTENT);
  assert.equal(oc.provider.anthropic.name, "Cosmo");
  assert.equal(oc.provider.anthropic.models["claude-sonnet-5-5"].name, "Orbit");
  assert.deepEqual(Object.keys(oc.provider.anthropic.models["claude-sonnet-5-5"].variants), ["none", "minimal", "xhigh", "max"]);
  const out = renderUserPolicy(c, ENV, { codexBundledCatalog: { models: [{ slug: "gpt-5.6-terra", supported_in_api: true, display_name: "GPT", description: "x", default_reasoning_level: "medium", supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })) }] } }, { catalogPath: "/x" });
  const [entry] = out.codexCatalog.models;
  assert.equal(entry.display_name, "Comet");
  assert.equal(entry.description, "");
  assert.deepEqual(entry.supported_reasoning_levels.map((l) => l.effort), ["low", "medium"]);
  assert.equal(entry.default_reasoning_level, "low");
  assert.ok(out.codexArgs.includes('model_reasoning_effort="low"'));
});

test("instructions: every engine gets the task's, from the process that starts it or a read-only file", () => {
  const c = valid({ agents: ["opencosmo", "cosmodex", "cosmo-code"], instructions: "  Stay in the workspace.  " });
  assert.equal(c.instructions, "Stay in the workspace.");
  const out = renderUserPolicy(c, ENV, { codexBundledCatalog: CATALOG }, { catalogPath: "/x", instructionsPath: "/s/instructions.md" });
  assert.deepEqual(JSON.parse(out.engineEnv.opencode.OPENCODE_CONFIG_CONTENT).instructions, ["/s/instructions.md"]);
  assert.ok(out.codexArgs.includes('developer_instructions="Stay in the workspace."'));
  assert.equal(out.engineEnv.claude.COSMO_CODE_INSTRUCTIONS, "Stay in the workspace.");
  assert.equal(valid({ agents: ["cosmodex"] }).instructions, undefined);
  assert.equal(validateTaskConfig({ agents: ["cosmodex"], instructions: 5 }).ok, false);
});

test("app: a port for the task's own web app, never one of the simulation's", () => {
  assert.deepEqual(valid({ agents: ["cosmo-code"], app: { port: 5173 } }).app, { port: 5173, path: "/app/" });
  assert.equal(valid({ agents: ["cosmo-code"] }).app, undefined);
  // A normalized config validates again (the server re-reads the applied policy).
  assert.deepEqual(valid(valid({ agents: ["cosmo-code"], app: { port: 5173 } })).app, { port: 5173, path: "/app/" });
  assert.equal(validateTaskConfig({ agents: ["cosmo-code"], app: { port: 5173, path: "/x/" } }).ok, false);
  for (const app of [{ port: 3000 }, { port: 4500 }, { port: 80 }, { port: "5173" }, { port: 5173, base: "/x/" }, []]) {
    assert.equal(validateTaskConfig({ agents: ["cosmo-code"], app }).ok, false, JSON.stringify(app));
  }
});

test("a task app gives Codex's sandbox network access (a dev server must listen)", () => {
  const c = valid({ agents: ["cosmodex"], app: { port: 5173 } });
  const out = renderUserPolicy(c, ENV, { codexBundledCatalog: CATALOG }, { catalogPath: "/x" });
  assert.ok(out.codexArgs.includes("sandbox_workspace_write.network_access=true"));
  assert.equal(codexCeilings(c).network, true);
  assert.equal(codexCeilings(valid({ agents: ["cosmodex"] })).network, false);
});
