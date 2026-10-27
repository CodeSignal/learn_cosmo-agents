// Every client→server method of `codex app-server` at the pinned version (0.161.0, from
// `codex app-server generate-json-schema`), with what the gateway does with it: "allow",
// "terminal" (allowed only with a terminal), or the reason shown when it is refused. A method
// not listed is unknown and answered with "method not found".

export const CODEX_VERSION = "0.161.0";

const SIGN_IN = "signing in";
const CONFIG = "configuration";
const PLUGINS = "plugins";
const MCP = "MCP servers";
const HISTORY = "the session history";
const IMPORT = "settings from other agents";
const FEEDBACK = "sending feedback";
const REVIEWER = "the approval reviewer";

export const METHODS = {
  // Handled by the gateway itself.
  initialize: "the connection",
  "account/read": "allow",
  "account/rateLimits/read": "allow",
  "account/usage/read": "allow",
  "account/workspaceMessages/read": "allow",
  "account/login/start": SIGN_IN,
  "account/login/cancel": SIGN_IN,
  "account/logout": SIGN_IN,
  "account/gatewayOAuth/login": SIGN_IN,
  "account/gatewayOAuth/cancel": SIGN_IN,
  "account/gatewayOAuth/read": "allow",
  "account/rateLimitResetCredit/consume": SIGN_IN,
  "account/sendAddCreditsNudgeEmail": SIGN_IN,
  "app/installed": "allow",
  "app/list": "allow",
  "app/read": "allow",
  "command/exec": "terminal",
  "command/exec/resize": "terminal",
  "command/exec/terminate": "terminal",
  "command/exec/write": "terminal",
  "config/read": "allow",
  "config/batchWrite": CONFIG,
  "config/value/write": CONFIG,
  "config/mcpServer/reload": MCP,
  "configRequirements/read": "allow",
  "experimentalFeature/list": "allow",
  "experimentalFeature/enablement/set": CONFIG,
  "externalAgentConfig/detect": IMPORT,
  "externalAgentConfig/import": IMPORT,
  "externalAgentConfig/import/readHistories": IMPORT,
  "externalAgentConfig/import/recordHistory": IMPORT,
  "feedback/upload": FEEDBACK,
  "fs/copy": "allow",
  "fs/createDirectory": "allow",
  "fs/getMetadata": "allow",
  "fs/readDirectory": "allow",
  "fs/readFile": "allow",
  "fs/remove": "allow",
  "fs/unwatch": "allow",
  "fs/watch": "allow",
  "fs/writeFile": "allow",
  fuzzyFileSearch: "allow",
  "hooks/list": "allow",
  "marketplace/add": PLUGINS,
  "marketplace/remove": PLUGINS,
  "marketplace/upgrade": PLUGINS,
  "mcpServer/oauth/login": MCP,
  "mcpServer/resource/read": MCP,
  "mcpServer/tool/call": MCP,
  "mcpServerStatus/list": "allow",
  "model/list": "allow",
  "modelProvider/capabilities/read": "allow",
  "permissionProfile/list": "allow",
  "plugin/install": PLUGINS,
  "plugin/installed": "allow",
  "plugin/list": "allow",
  "plugin/read": "allow",
  "plugin/reconcile": PLUGINS,
  "plugin/share/checkout": PLUGINS,
  "plugin/share/delete": PLUGINS,
  "plugin/share/list": "allow",
  "plugin/share/save": PLUGINS,
  "plugin/share/updateTargets": PLUGINS,
  "plugin/skill/read": "allow",
  "plugin/uninstall": PLUGINS,
  "review/start": "allow",
  "skills/list": "allow",
  "skills/config/write": CONFIG,
  "skills/extraRoots/set": CONFIG,
  "thread/approveGuardianDeniedAction": REVIEWER,
  "thread/archive": "allow",
  "thread/unarchive": "allow",
  "thread/attachment/add": "allow",
  "thread/attachment/list": "allow",
  "thread/attachment/remove": "allow",
  "thread/compact/start": "allow",
  "thread/delete": HISTORY, // deleting a thread would erase its transcript
  "thread/fork": "allow",
  "thread/goal/clear": "allow",
  "thread/goal/get": "allow",
  "thread/goal/set": "allow",
  "thread/inject_items": HISTORY, // writes items into a thread's history directly
  "thread/items/list": "allow",
  "thread/list": "allow",
  "thread/loaded/list": "allow",
  "thread/metadata/update": "allow",
  "thread/name/set": "allow",
  "thread/read": "allow",
  "thread/resume": "allow",
  "thread/revert": "allow",
  "thread/section/move": "allow",
  "thread/shellCommand": "terminal", // the composer's direct shell
  "thread/start": "allow",
  "thread/turns/list": "allow",
  "thread/unsubscribe": "allow",
  "threadSection/create": "allow",
  "threadSection/delete": "allow",
  "threadSection/list": "allow",
  "threadSection/update": "allow",
  "turn/interrupt": "allow",
  "turn/start": "allow",
  "turn/steer": "allow",
  // windowsSandbox/* doesn't apply on Linux: not listed, refused.
};

/** Server→client requests the candidate answers, and the answers that are plain decisions. */
export const DECISIONS = {
  "item/commandExecution/requestApproval": ["accept", "acceptForSession", "decline", "cancel"],
  "item/fileChange/requestApproval": ["accept", "acceptForSession", "decline", "cancel"],
  execCommandApproval: ["approved", "approved_for_session", "denied", "abort"],
  applyPatchApproval: ["approved", "approved_for_session", "denied", "abort"],
};

/** Server→client requests the candidate answers with free-form content. */
export const USER_INPUT = new Set(["item/tool/requestUserInput"]);
