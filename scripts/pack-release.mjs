#!/usr/bin/env node
// Builds the release tarball: what installs as /opt/agentsim, with no node_modules.
//   npm run build && sh scripts/build-ui.sh && npm run pack     -> pack/ and release.tar.gz
// Every script the simulation runs becomes one minified ES module at its usual path (the
// supervisor finds the server, the engine host and find-owners next to itself), with the built
// shell (dist/), the agent UIs (dist-agents/), the sudo entry points (bin/), the sudoers entry and
// install.sh beside them. The engine host's dependencies stay outside: the Agent SDK isn't ours to
// redistribute, so the image installs them from the shipped lockfile, as it installs the engines.
// `npm run verify:release` unpacks and boots the result.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "pack");
const TARBALL = path.join(ROOT, "release.tar.gz");

/** Entry points, each bundled with what it imports into one file at the same path. */
export const ENTRY_POINTS = [
  "server/index.mjs",
  "root/apply-policy.mjs",
  "root/supervisor.mjs",
  "root/find-owners.mjs",
  "engines/claude-host/host.mjs",
  "scripts/summary.mjs",
];

/** Copied as they are: [from, to]. */
export const FILES = [
  ["dist", "dist"],
  ["dist-agents", "dist-agents"],
  ["root/bin", "bin"],
  ["root/sudoers", "sudoers"],
  ["root/install.sh", "install.sh"],
  ["scripts/run_solution.sh", "scripts/run_solution.sh"],
  ["scripts/session-setup.sh", "scripts/session-setup.sh"],
  // The image installs the engines from the pin table (the code has it compiled in).
  ["policy/pins.json", "policy/pins.json"],
  ["engines/claude-host/package.json", "engines/claude-host/package.json"],
  ["engines/claude-host/package-lock.json", "engines/claude-host/package-lock.json"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
];

const shipped = (src) => !/\.map$/.test(src) && !path.basename(src).startsWith("._") && path.basename(src) !== ".DS_Store";

async function main() {
  for (const need of ["dist/index.html", "dist-agents/opencosmo/index.html", "dist-agents/cosmodex/index.html", "dist-agents/cosmo-code/index.html"]) {
    if (!fs.existsSync(path.join(ROOT, need))) throw new Error(`${need} is missing: run \`npm run build\` and \`sh scripts/build-ui.sh\` first`);
  }
  fs.rmSync(PACK, { recursive: true, force: true });
  fs.mkdirSync(PACK);

  for (const entry of ENTRY_POINTS) {
    await esbuild.build({
      absWorkingDir: ROOT,
      entryPoints: [entry],
      outfile: path.join(PACK, entry),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      minify: true,
      keepNames: true,
      legalComments: "none",
      // The engine host's npm dependencies are installed beside it (see above).
      packages: entry.startsWith("engines/") ? "external" : undefined,
      logLevel: "warning",
    });
  }
  for (const [from, to] of FILES) {
    fs.cpSync(path.join(ROOT, from), path.join(PACK, to), { recursive: true, filter: shipped });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  fs.writeFileSync(
    path.join(PACK, "package.json"),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module", license: "Elastic-2.0" }, null, 2)}\n`,
  );

  fs.rmSync(TARBALL, { force: true });
  execFileSync("tar", ["-czf", TARBALL, "-C", PACK, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });

  console.log("Packed release (no node_modules):");
  for (const rel of [...ENTRY_POINTS, "dist", "dist-agents"]) console.log(`  ${rel.padEnd(32)} ${size(sizeOf(path.join(PACK, rel)))}`);
  console.log(`  ${"pack/ (unpacked)".padEnd(32)} ${size(sizeOf(PACK))}`);
  console.log(`  ${"release.tar.gz".padEnd(32)} ${size(fs.statSync(TARBALL).size)}`);
}

const sizeOf = (file) => {
  const stat = fs.statSync(file);
  return stat.isDirectory() ? fs.readdirSync(file).reduce((sum, name) => sum + sizeOf(path.join(file, name)), 0) : stat.size;
};
const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`pack failed: ${error.message}`);
    process.exit(1);
  });
}
