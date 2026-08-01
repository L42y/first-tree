#!/usr/bin/env node
/**
 * Release-pack smoke: prove the public npm packaging boundary works for the
 * built CLI under the trusted-publishing npm client the workflow pins.
 *
 *   1. `npm pack` the built apps/cli package through REAL pack semantics
 *      (prepack copies skills + materializes bundled deps, postpack restores —
 *      no --ignore-scripts), writing the tarball into a run-owned temp
 *      directory via `--pack-destination` so apps/cli is never overwritten.
 *   2. Enumerate every tarball entry and reject traversal / absolute /
 *      escaping-link / non-canonical package paths (the npm registry E415 class).
 *   3. Install the tarball into an empty consumer with plain npm.
 *   4. Run the public CLI (`--version`).
 *   5. Resolve the bundled `@botiverse/kimi-code-sdk` from the consumer and
 *      assert the patched sites this release ships: create-time drain flag,
 *      resume option threading, resume main-agent flag application, and the
 *      awaited replay-fence authorization hook.
 *
 * Failures throw; the outermost handler always cleans *this run's* pack
 * destination, temp consumers, and any stranded materialize journal before
 * exiting non-zero. Pre-existing `first-tree-dev-*.tgz` files in apps/cli —
 * including ones that share npm pack's deterministic current name/version —
 * are snapshotted by path+digest and never overwritten or deleted. Helpers
 * never call `process.exit`.
 *
 * No registry publish, no credentials, no network beyond npm itself.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listCliTarballs() {
  return readdirSync(CLI_ROOT)
    .filter((name) => /^first-tree-dev-.*\.tgz$/.test(name))
    .map((name) => join(CLI_ROOT, name))
    .sort();
}

function expectedPackFilename() {
  const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8"));
  const name = String(pkg.name ?? "")
    .replace(/^@/, "")
    .replace(/\//g, "-");
  return `${name}-${pkg.version}.tgz`;
}

/**
 * Path → sha256 digest for every pre-existing apps/cli tarball. Digests catch
 * same-name overwrites that path-only ownership cannot see.
 * @type {Map<string, string>}
 */
const preexistingTarballDigests = new Map();

/** @type {string | undefined} Active run-owned work directory (pack + consumer). */
let activeWorkDir;

function snapshotPreexistingTarballs() {
  preexistingTarballDigests.clear();
  for (const tarball of listCliTarballs()) {
    preexistingTarballDigests.set(tarball, sha256File(tarball));
  }
}

/**
 * Pack into a run-owned destination so npm's deterministic filename cannot
 * overwrite a developer artifact already present under apps/cli.
 * @param {string} packDestination
 * @returns {string} absolute path of the packed tarball
 */
function packCliInto(packDestination) {
  // npm pack does not create pack-destination; missing dirs surface as ENOENT
  // while writing the deterministic tarball name.
  mkdirSync(packDestination, { recursive: true });
  run("npm", ["pack", "--json", "--pack-destination", packDestination], { cwd: CLI_ROOT });
  const expectedName = expectedPackFilename();
  const tarball = join(packDestination, expectedName);
  if (!existsSync(tarball)) {
    const found = readdirSync(packDestination).filter((name) => name.endsWith(".tgz"));
    fail(`expected packed tarball at ${tarball}, found: ${found.join(", ") || "(none)"}`);
  }
  return tarball;
}

/**
 * Remove only run-owned temp work (pack destination + consumer) and any
 * stranded materialize journal. Never deletes or rewrites apps/cli tarballs.
 * @param {string | undefined} workDir
 */
function cleanupPackArtifacts(workDir) {
  const target = workDir ?? activeWorkDir;
  activeWorkDir = undefined;
  if (target) {
    rmSync(target, { recursive: true, force: true });
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

/**
 * @param {Map<string, string>} symlinkSnapshot
 */
function assertCleanWorkspace(symlinkSnapshot) {
  const current = new Set(listCliTarballs());
  for (const tarball of current) {
    if (!preexistingTarballDigests.has(tarball)) {
      fail(`cleanup left work-owned tarball residue under apps/cli: ${tarball}`);
    }
  }
  for (const [tarball, digest] of preexistingTarballDigests) {
    if (!existsSync(tarball)) {
      fail(`cleanup deleted pre-existing tarball it does not own: ${tarball}`);
    }
    const now = sha256File(tarball);
    if (now !== digest) {
      fail(`pre-existing tarball was overwritten or altered: ${tarball} (was ${digest}, now ${now})`);
    }
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
  activeWorkDir = work;
  try {
    const packDir = join(work, "pack");
    const consumerDir = join(work, "consumer");
    const tarball = packCliInto(packDir);
    const tarballName = basename(tarball);

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

    const sha256 = sha256File(tarball);
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
 * Deterministic negative cleanup regression: pack succeeds into a run-owned
 * destination, then an injected post-pack failure must still remove that
 * work tree and restore symlinks — without touching apps/cli tarballs.
 */
function selftestCleanup() {
  if (!existsSync(join(CLI_ROOT, "dist", "cli", "index.mjs"))) {
    fail("apps/cli/dist is missing — run `pnpm build` before selftest-cleanup");
  }
  const symlinkSnapshot = captureBundledSymlinks();
  const work = mkdtempSync(join(tmpdir(), "first-tree-release-pack-smoke-neg-"));
  activeWorkDir = work;
  let failedAsExpected = false;
  let packedPath;
  try {
    try {
      packedPath = packCliInto(join(work, "pack"));
      if (!existsSync(packedPath)) fail("selftest-cleanup: pack did not produce a tarball");
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
  if (packedPath && existsSync(packedPath)) fail("selftest-cleanup left run-owned packed tarball");
  console.log("release-pack-smoke: selftest-cleanup PASS");
}

/**
 * Prove pack destination isolation preserves a pre-existing artifact that
 * already uses npm pack's deterministic current name/version filename —
 * verified by content digest across success and failure cleanup.
 */
function selftestPreservePreexistingTarball() {
  const deterministicName = expectedPackFilename();
  const collisionPath = join(CLI_ROOT, deterministicName);
  const sentinelBody = `preexisting-deterministic-sentinel:${deterministicName}\n`;
  const createdBySelftest = !existsSync(collisionPath);
  if (createdBySelftest) {
    writeFileSync(collisionPath, sentinelBody);
  }
  const expectedDigest = sha256File(collisionPath);
  const expectedBytes = createdBySelftest ? sentinelBody : readFileSync(collisionPath);

  try {
    snapshotPreexistingTarballs();
    if (!preexistingTarballDigests.has(collisionPath)) {
      fail("selftest-preserve: deterministic preexisting tarball was not snapshotted");
    }
    if (preexistingTarballDigests.get(collisionPath) !== expectedDigest) {
      fail("selftest-preserve: snapshot digest mismatch before pack");
    }

    if (!existsSync(join(CLI_ROOT, "dist", "cli", "index.mjs"))) {
      fail("apps/cli/dist is missing — run `pnpm build` before selftest-preserve-preexisting");
    }
    const symlinkSnapshot = captureBundledSymlinks();

    // Success-path: pack into run-owned destination; collision path must keep
    // the exact preexisting bytes (path-only ownership cannot catch overwrite).
    const work = mkdtempSync(join(tmpdir(), "first-tree-release-pack-smoke-preserve-"));
    activeWorkDir = work;
    try {
      const packed = packCliInto(join(work, "pack"));
      if (basename(packed) !== deterministicName) {
        fail(`selftest-preserve: packed name ${basename(packed)} !== ${deterministicName}`);
      }
      if (sha256File(packed) === expectedDigest && createdBySelftest) {
        fail("selftest-preserve: packed artifact unexpectedly matched sentinel digest");
      }
      if (sha256File(collisionPath) !== expectedDigest) {
        fail("selftest-preserve: pack overwrote the deterministic preexisting tarball");
      }
    } finally {
      cleanupPackArtifacts(work);
    }
    assertCleanWorkspace(symlinkSnapshot);
    if (!existsSync(collisionPath) || sha256File(collisionPath) !== expectedDigest) {
      fail("selftest-preserve: success cleanup deleted or altered the deterministic preexisting tarball");
    }
    if (createdBySelftest && readFileSync(collisionPath, "utf8") !== sentinelBody) {
      fail("selftest-preserve: sentinel body changed after success cleanup");
    }

    // Failure-path cleanup via top-level catch must likewise leave digests alone.
    try {
      fail("injected top-level failure for preexisting preservation");
    } catch (error) {
      if (!(error instanceof SmokeFailure)) throw error;
      cleanupPackArtifacts(undefined);
    }
    if (!existsSync(collisionPath) || sha256File(collisionPath) !== expectedDigest) {
      fail("selftest-preserve: failure cleanup deleted or altered the deterministic preexisting tarball");
    }
    if (createdBySelftest && Buffer.compare(readFileSync(collisionPath), Buffer.from(expectedBytes)) !== 0) {
      fail("selftest-preserve: sentinel bytes changed after failure cleanup");
    }

    console.log(
      `release-pack-smoke: selftest-preserve-preexisting PASS — preserved ${deterministicName} sha256=${expectedDigest}`,
    );
  } finally {
    if (createdBySelftest) {
      rmSync(collisionPath, { force: true });
    }
    preexistingTarballDigests.delete(collisionPath);
  }
}

function main() {
  snapshotPreexistingTarballs();
  const action = process.argv[2];
  try {
    if (action === "selftest-cleanup") selftestCleanup();
    else if (action === "selftest-preserve-preexisting") selftestPreservePreexistingTarball();
    else if (action === undefined) runSmoke();
    else
      fail(`unknown action '${action}' (expected default smoke, selftest-cleanup, or selftest-preserve-preexisting)`);
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
