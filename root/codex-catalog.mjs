// Codex's bundled model catalog (`codex debug models --bundled`), read in a throwaway CODEX_HOME
// so nothing the session user configured can change it. Root runs it as nobody.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** The parsed catalog, or null when the CLI is missing or prints something else. */
export function bundledCodexCatalog() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentsim-codex-"));
  fs.chmodSync(tmp, 0o777);
  try {
    const res = spawnSync("codex", ["debug", "models", "--bundled"], {
      cwd: tmp,
      env: { PATH: process.env.PATH, HOME: tmp, CODEX_HOME: tmp },
      encoding: "utf8",
      timeout: 60_000,
      ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
    });
    if (res.status !== 0) return null;
    return JSON.parse(res.stdout);
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
