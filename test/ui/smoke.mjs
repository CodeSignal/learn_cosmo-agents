// UI smoke test: drives each agent UI in a throwaway headless Chrome (DevTools protocol, real key
// events), the way a learner would: open the agent, send a prompt that runs a command, approve
// it, and see the reply. Needs a running simulation with the stand-in LLM proxy (its RUN: script)
// and a local Chrome:
//   sh scripts/dev-container.sh && node test/ui/smoke.mjs [--base http://localhost:3010] [--out dir]
// CHROME=<path> picks the browser. Prints one "PASS|FAIL <id> <description>" line per check and
// saves a screenshot per agent.
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const BASE = arg("base", "http://localhost:3010").replace(/\/+$/, "");
const OUT = arg("out", fs.mkdtempSync(path.join(os.tmpdir(), "cosmo-ui-")));
const CHROME =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function report(id, desc, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${desc}${ok || !detail ? "" : `\n      ${String(detail).slice(0, 300)}`}`);
}

// ── Chrome over the DevTools protocol ───────────────────────────────────────────────────────

async function launch() {
  if (!CHROME) throw new Error("no Chrome found; set CHROME");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cosmo-ui-profile-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let next = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else for (const fn of listeners) fn(m);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return {
    send,
    on: (fn) => listeners.add(fn),
    async close() {
      ws.close();
      chrome.kill();
      if (chrome.exitCode === null) await once(chrome, "exit");
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** A page in its own tab, with helpers that wait for the UI. */
async function openPage(browser, url) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  const errors = [];
  browser.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1260, height: 820, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    errors,
    evaluate,
    /** Wait until the expression is truthy (and return it). */
    async until(expression, ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await evaluate(expression).catch(() => undefined);
        if (v) return v;
        await sleep(200);
      }
      throw new Error(`timed out waiting for ${expression.slice(0, 120)}`);
    },
    type: (text) => send("Input.insertText", { text }),
    async key(key, { ctrl = false } = {}) {
      const codes = { Enter: ["Enter", 13, "\r"] };
      const [code, vk, text] = codes[key];
      const modifiers = ctrl ? 2 : 0;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers, ...(ctrl ? {} : { text }) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
    },
    async screenshot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(data, "base64"));
    },
  };
}

const button = (label) => `[...document.querySelectorAll("button")].find((b) => b.offsetParent && b.textContent.trim().startsWith(${JSON.stringify(label)}))`;

// ── what each agent's UI looks like ─────────────────────────────────────────────────────────

const AGENTS = {
  opencosmo: {
    async start(page) {
      await page.until(button("New session"));
      await page.evaluate(`${button("New session")}.click()`);
      return '[data-component="prompt-input"]';
    },
    approve: (page) => page.evaluate(`${button("Allow once")}.click()`),
    asked: button("Allow once"),
  },
  cosmodex: {
    start: async () => ".cx-input",
    approve: (page) => page.evaluate(`${button("Allow once")}.click()`),
    asked: button("Allow once"),
  },
  "cosmo-code": {
    start: async () => ".cc-prompt",
    // As in the original: the card's "Allow once" is Ctrl+Enter while the composer has focus.
    approve: (page) => page.key("Enter", { ctrl: true }),
    asked: `[...document.querySelectorAll("*")].some((e) => e.children.length === 0 && /^Allow Claude to /.test(e.textContent))`,
  },
};

// ── checks ──────────────────────────────────────────────────────────────────────────────────

const session = await (await fetch(`${BASE}/api/session`)).json();
const browser = await launch();
try {
  const shell = await openPage(browser, `${BASE}/`);
  const active = session.agents.find((a) => a.id === session.active);
  const shown = await shell.until(`[...document.querySelectorAll("iframe")].some((f) => f.src.includes("/agents/${session.active}/") && f.offsetParent)`).catch((e) => e);
  report("U0", `the shell shows the active agent (${active?.label ?? session.active})${session.allowSwitch ? " and the switcher" : ""}`, shown === true && (!session.allowSwitch || (await shell.evaluate(`!!document.querySelector("#agent-switcher button")`))), shown);

  let n = 0;
  for (const agent of session.agents.filter((a) => a.available)) {
    n++;
    const ui = AGENTS[agent.id];
    if (!ui) continue;
    const page = await openPage(browser, `${BASE}/agents/${agent.id}/`);
    const marker = `smoke-${agent.id}-${Date.now()}`;
    try {
      const composer = await ui.start(page);
      await page.until(`document.querySelector(${JSON.stringify(composer)})`);
      await page.evaluate(`document.querySelector(${JSON.stringify(composer)}).focus()`);
      await page.type(`RUN: echo ${marker}`);
      await page.key("Enter");
      await page.until(ui.asked);
      await ui.approve(page);
      // The stand-in proxy answers "done (model=…)" once the command's result is back.
      await page.until(`document.body.innerText.includes(${JSON.stringify(marker)}) && /done \\(model=/.test(document.body.innerText)`, 30000);
      await page.screenshot(path.join(OUT, `${agent.id}.png`));
      report(`U${n}`, `${agent.label}: a prompt runs a command after approval, and the reply shows`, page.errors.length === 0, page.errors.join(" | "));
    } catch (error) {
      await page.screenshot(path.join(OUT, `${agent.id}-failed.png`)).catch(() => {});
      report(`U${n}`, `${agent.label}: a prompt runs a command after approval, and the reply shows`, false, error.message);
    }
  }
  console.log(`screenshots: ${OUT}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
