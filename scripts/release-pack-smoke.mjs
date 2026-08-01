#!/usr/bin/env node
/**
 * Release-pack smoke: prove the public npm packaging boundary works for the
 * built CLI under the trusted-publishing npm client the workflow pins.
 *
 *   1. `npm pack` the built apps/cli package through REAL pack semantics
 *      (prepack copies skills + materializes bundled deps, postpack restores —
 *      no --ignore-scripts).
 *   2. Enumerate every tarball entry and reject traversal / absolute /
 *      escaping-link / non-canonical package paths (the npm registry E415 class).
 *   3. Install the tarball into an empty consumer with plain npm.
 *   4. Run the public CLI (`--version`).
 *   5. Resolve the bundled `@botiverse/kimi-code-sdk` from the consumer and
 *      assert the patched sites this release ships: create-time drain flag,
 *      resume option threading, resume main-agent flag application, and the
 *      awaited replay-fence authorization hook.
 *
 * Failures throw; the outermost handler always cleans tarballs, temp consumers,
 * and any stranded materialize journal before exiting non-zero. Helpers never
 * call `process.exit`.
 *
 * No registry publish, no credentials, no network beyond npm itself.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNpmTarballRegistrySafe } from "./npm-tarball-safety.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CLI_ROOT = join(REPO_ROOT, "apps", "cli");
const MATERIALIZE_SCRIPT = join(CLI_ROOT, "scripts", "materialize-bundled-deps.mjs");
const MANIFEST_PATH = join(CLI_ROOT, ".bundled-deps-materialize.json");

class SmokeFailure extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SmokeFailure";
  }
}

function fail(message) {
  throw new SmokeFailure(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} exited ${result.status}\n${detail}`);
  }
  return result;
}

function listCliTarballs() {
  return readdirSync(CLI_ROOT)
    .filter((name) => /^first-tree-dev-.*\.tgz$/.test(name))
    .map((name) => join(CLI_ROOT, name));
}

function cleanupPackArtifacts(workDir) {
  for (const tarball of listCliTarballs()) {
    rmSync(tarball, { force: true });
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (existsSync(MANIFEST_PATH)) {
    const restore = spawnSync(process.execPath, [MATERIALIZE_SCRIPT, "restore"], {
      cwd: CLI_ROOT,
      encoding: "utf8",
    });
    if (restore.status !== 0) {
      console.error(
        `release-pack-smoke: WARNING: materialize restore during cleanup failed:\n${restore.stderr || restore.stdout}`,
      );
    }
  }
}

function assertCleanWorkspace(symlinkSnapshot) {
  if (listCliTarballs().length !== 0) {
    fail(`cleanup left tarball residue: ${listCliTarballs().join(", ")}`);
  }
  if (existsSync(MANIFEST_PATH)) {
    fail("cleanup left stranded materialize manifest");
  }
  for (const [name, target] of symlinkSnapshot) {
    const dir = join(CLI_ROOT, "node_modules", ...name.split("/"));
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      fail(`cleanup missing package path for ${name}`);
    }
    if (!stat.isSymbolicLink()) {
      fail(`cleanup left real copy instead of symlink for ${name}`);
    }
    if (readlinkSync(dir) !== target) {
      fail(`cleanup restored wrong symlink target for ${name}`);
    }
  }
}

function captureBundledSymlinks() {
  /** @type {Map<string, string>} */
  const snapshot = new Map();
  const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8"));
  const bundled = pkg.bundleDependencies ?? [];
  const names = new Set(bundled);
  for (const name of bundled) {
    const dir = join(CLI_ROOT, "node_modules", ...name.split("/"));
    try {
      const depPkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      for (const dep of Object.keys(depPkg.dependencies ?? {})) {
        if (existsSync(join(CLI_ROOT, "node_modules", ...dep.split("/"), "package.json"))) {
          names.add(dep);
        }
      }
    } catch {
      // ignore — prepare/preflight owns hard failures
    }
  }
  for (const name of names) {
    const dir = join(CLI_ROOT, "node_modules", ...name.split("/"));
    const stat = lstatSync(dir);
    if (!stat.isSymbolicLink()) {
      fail(`precondition: ${name} must be a pnpm symlink before smoke`);
    }
    snapshot.set(name, readlinkSync(dir));
  }
  return snapshot;
}

function runSmoke() {
  if (!existsSync(join(CLI_ROOT, "dist", "cli", "index.mjs")) || !existsSync(join(CLI_ROOT, "dist", "index.mjs"))) {
    fail("apps/cli/dist is missing — run `pnpm build` first");
  }

  const symlinkSnapshot = captureBundledSymlinks();
  const work = mkdtempSync(join(tmpdir(), "first-tree-release-pack-smoke-"));
  try {
    const consumerDir = join(work, "consumer");
    run("npm", ["pack", "--json"], { cwd: CLI_ROOT });
    const tarballs = listCliTarballs();
    if (tarballs.length !== 1) {
      fail(`expected exactly one first-tree-dev tarball in apps/cli, got ${tarballs.length}`);
    }
    const tarball = tarballs[0];
    const tarballName = tarball.split("/").pop();

    const safety = assertNpmTarballRegistrySafe(tarball);

    run("npm", ["install", "--prefix", consumerDir, tarball]);
    const binName = "first-tree-dev";
    const binPath = join(consumerDir, "node_modules", ".bin", binName);
    if (!existsSync(binPath)) fail(`consumer is missing ${binPath}`);
    const version = run(binPath, ["--version"]);
    const versionText = version.stdout.trim();
    if (!/^\d+\.\d+\.\d+/.test(versionText)) fail(`unexpected --version output: ${versionText}`);

    const sdkEntry = join(
      consumerDir,
      "node_modules",
      "first-tree-dev",
      "node_modules",
      "@botiverse",
      "kimi-code-sdk",
      "dist",
      "index.mjs",
    );
    if (!existsSync(sdkEntry)) {
      fail(`consumer did not resolve the bundled Kimi SDK at ${sdkEntry} — bundleDependencies is not shipping`);
    }
    const source = readFileSync(sdkEntry, "utf8");
    const requiredSites = [
      ["create drain flag", "if (this.options.drainAgentTasksOnStop) agent.printDrainAgentTasksOnStop = true"],
      ["resume option threading", "drainAgentTasksOnStop: input.drainAgentTasksOnStop"],
      ["resume main-agent flag", "this.options.drainAgentTasksOnStop) main.printDrainAgentTasksOnStop = true"],
      ["awaited replay-fence authorization hook", "__firstTreeBeforeToolCall"],
    ];
    for (const [label, needle] of requiredSites) {
      if (!source.includes(needle)) fail(`bundled Kimi SDK is missing the ${label} site`);
    }

    run(process.execPath, [
      "-e",
      `import(${JSON.stringify(`file://${sdkEntry}`)}).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); })`,
    ]);

    const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const bytes = statSync(tarball).size;
    console.log(
      `release-pack-smoke: PASS — packed ${tarballName} (${bytes} B, sha256=${sha256}, ${safety.entryCount} entries), consumer CLI ${versionText}, registry-safe paths, bundled patched Kimi SDK verified`,
    );
  } finally {
    cleanupPackArtifacts(work);
    assertCleanWorkspace(symlinkSnapshot);
  }
}

/**
 * Deterministic negative cleanup regression: pack succeeds, then an injected
 * post-pack failure must still remove tgz/temp/manifest and restore symlinks
 * before the process exits non-zero.
 */
function selftestCleanup() {
  if (!existsSync(join(CLI_ROOT, "dist", "cli", "index.mjs"))) {
    fail("apps/cli/dist is missing — run `pnpm build` before selftest-cleanup");
  }
  const symlinkSnapshot = captureBundledSymlinks();
  const work = mkdtempSync(join(tmpdir(), "first-tree-release-pack-smoke-neg-"));
  let failedAsExpected = false;
  try {
    try {
      run("npm", ["pack", "--json"], { cwd: CLI_ROOT });
      const tarballs = listCliTarballs();
      if (tarballs.length !== 1) fail(`expected one tarball before injected failure, got ${tarballs.length}`);
      fail("injected post-pack failure for cleanup regression");
    } catch (error) {
      if (!(error instanceof SmokeFailure) || !error.message.includes("injected post-pack failure")) {
        throw error;
      }
      failedAsExpected = true;
    }
  } finally {
    cleanupPackArtifacts(work);
  }

  if (!failedAsExpected) fail("selftest-cleanup did not take the injected failure path");
  assertCleanWorkspace(symlinkSnapshot);
  if (existsSync(work)) fail("selftest-cleanup left consumer work directory");
  console.log("release-pack-smoke: selftest-cleanup PASS");
}

function main() {
  const action = process.argv[2];
  try {
    if (action === "selftest-cleanup") selftestCleanup();
    else if (action === undefined) runSmoke();
    else fail(`unknown action '${action}' (expected default smoke or selftest-cleanup)`);
  } catch (error) {
    try {
      cleanupPackArtifacts(undefined);
    } catch (cleanupError) {
      console.error(
        `release-pack-smoke: cleanup after failure also failed: ${
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        }`,
      );
    }
    console.error(`release-pack-smoke: FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

main();
