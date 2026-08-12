#!/usr/bin/env node
/**
 * Pack-time preparation for the public CLI npm artifact.
 *
 * 1. Materialize `bundleDependencies` (and the bundled packages' direct deps that
 *    resolve from this package's node_modules) as real directories before `npm pack`
 *    / `npm publish`.
 *
 *    Why: the workspace is installed with pnpm, so `node_modules/<pkg>` entries are
 *    symlinks into `node_modules/.pnpm/...`. npm 11.5.1's pack path follows those
 *    links and writes tar entry names like `package/../../node_modules/.pnpm/...`.
 *    The npm registry rejects that layout with E415 ("invalid path"). Replacing
 *    the pack-time inputs with in-package real copies keeps every tar entry under
 *    `package/` with no `..` traversal, while preserving `bundleDependencies` and
 *    the patched Kimi SDK payload.
 *
 * 2. Stage a registry-safe public `package.json` by stripping the entire
 *    `devDependencies` field. Source keeps private `@first-tree/*` packages as
 *    `workspace:*` build-time inputs; consumers never install `devDependencies`,
 *    and publishing those coordinates would leak unpublishable workspace specs.
 *
 * Lifecycle:
 *   prepack  → node scripts/materialize-bundled-deps.mjs prepare
 *   postpack → node scripts/materialize-bundled-deps.mjs restore
 *
 * Recovery (failure-atomic):
 *   1. Preflight the full bundle closure and require every entry to still be a
 *      symlink (collect every original link target). Capture the exact source
 *      `package.json` bytes before any mutation.
 *   2. Persist the COMPLETE restore journal with write-temp + rename BEFORE the
 *      first unlink/cpSync / package.json rewrite.
 *   3. Mutate. Any failure (or a later prepare that finds a stranded journal)
 *      runs idempotent restore, which restores `package.json` byte-for-byte and
 *      can repair a mix of still-linked and already-materialized entries.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SCRIPT_DIR);
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, "package.json");
const NODE_MODULES = join(PACKAGE_ROOT, "node_modules");
const MANIFEST_PATH = join(PACKAGE_ROOT, ".bundled-deps-materialize.json");
const THIS_SCRIPT = fileURLToPath(import.meta.url);

function fail(message) {
  console.error(`materialize-bundled-deps: ${message}`);
  process.exit(1);
}

function readPackageJson(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function packageDir(name) {
  return join(NODE_MODULES, ...name.split("/"));
}

function lstatSyncSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function listBundleClosure(rootPkg) {
  const bundled = rootPkg.bundleDependencies ?? rootPkg.bundledDependencies ?? [];
  if (!Array.isArray(bundled) || bundled.length === 0) return [];

  const ordered = [];
  const seen = new Set();

  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    ordered.push(name);
    const dir = packageDir(name);
    if (!existsSync(join(dir, "package.json"))) return;
    const pkg = readPackageJson(dir);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      // Only materialize deps that already resolve beside this package. Transitive
      // store-only packages are not pack inputs unless npm can see them here.
      if (existsSync(join(packageDir(dep), "package.json"))) visit(dep);
    }
  };

  for (const name of bundled) visit(name);
  return ordered;
}

/** Persist the recovery journal via write-temp + rename. */
function persistManifest(payload) {
  const tmpPath = `${MANIFEST_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmpPath, MANIFEST_PATH);
}

/**
 * @returns {{ kind: "count", value: number } | { kind: "public-manifest" } | null}
 */
function parseFailAfter(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fail-after") {
      const raw = argv[i + 1] ?? "";
      if (raw === "public-manifest") return { kind: "public-manifest" };
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value) || value < 1) fail("--fail-after requires a positive integer or 'public-manifest'");
      return { kind: "count", value };
    }
    if (arg.startsWith("--fail-after=")) {
      const raw = arg.slice("--fail-after=".length);
      if (raw === "public-manifest") return { kind: "public-manifest" };
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value) || value < 1) fail("--fail-after requires a positive integer or 'public-manifest'");
      return { kind: "count", value };
    }
  }
  const fromEnv = process.env.MATERIALIZE_BUNDLED_DEPS_FAIL_AFTER;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (fromEnv === "public-manifest") return { kind: "public-manifest" };
    const value = Number.parseInt(fromEnv, 10);
    if (!Number.isFinite(value) || value < 1) {
      fail("MATERIALIZE_BUNDLED_DEPS_FAIL_AFTER requires a positive integer or 'public-manifest'");
    }
    return { kind: "count", value };
  }
  return null;
}

/**
 * Read every closure entry that must be materialized. Fail closed unless each
 * path is still a recoverable symlink.
 * @returns {{ name: string, path: string, linkTarget: string, resolvedSource: string }[]}
 */
function preflightEntries(names) {
  /** @type {{ name: string, path: string, linkTarget: string, resolvedSource: string }[]} */
  const entries = [];
  for (const name of names) {
    const dir = packageDir(name);
    if (!existsSync(join(dir, "package.json")) && !lstatSyncSafe(dir)?.isSymbolicLink()) {
      throw new Error(`bundle closure package missing from node_modules: ${name}`);
    }
    const stat = lstatSyncSafe(dir);
    if (!stat) throw new Error(`cannot stat ${name}`);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `expected symlink for ${name} but found a real path; refusing to materialize without a recoverable link target`,
      );
    }
    entries.push({
      name,
      path: relative(PACKAGE_ROOT, dir),
      linkTarget: readlinkSync(dir),
      resolvedSource: realpathSync(dir),
    });
  }
  return entries;
}

/**
 * Stage the public registry manifest: drop the entire `devDependencies` field
 * so private workspace build inputs never ship in the npm tarball metadata.
 * @param {string} originalText
 */
function stagePublicPackageManifest(originalText) {
  const pkg = JSON.parse(originalText);
  if (!Object.hasOwn(pkg, "devDependencies")) {
    throw new Error("source package.json is missing devDependencies; refusing to stage a no-op public manifest");
  }
  delete pkg.devDependencies;
  writeFileSync(PACKAGE_JSON_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
}

function prepare(options = {}) {
  const failAfter = options.failAfter ?? null;

  if (existsSync(MANIFEST_PATH)) {
    // A previous prepare without restore (interrupted pack / crashed mutation).
    // Restore first so we never nest a real copy on top of another real copy,
    // and so package.json never accumulates staged rewrites.
    restore({ allowMissing: true });
  }

  const packageJsonOriginal = readFileSync(PACKAGE_JSON_PATH, "utf8");
  const rootPkg = JSON.parse(packageJsonOriginal);
  const names = listBundleClosure(rootPkg);

  /** @type {{ name: string, path: string, linkTarget: string, resolvedSource: string }[]} */
  let entries = [];
  if (names.length > 0) {
    try {
      entries = preflightEntries(names);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  // Persist the COMPLETE journal before the first destructive mutation.
  const journal = {
    version: 2,
    packageJson: packageJsonOriginal,
    packageJsonSha256: sha256Text(packageJsonOriginal),
    entries: entries.map(({ name, path, linkTarget }) => ({ name, path, linkTarget })),
  };
  persistManifest(journal);

  let mutated = 0;
  try {
    for (const entry of entries) {
      const dir = join(PACKAGE_ROOT, entry.path);
      // Unlink the symlink itself — never rmSync a directory symlink without
      // care: Node may treat the target as the path and raise EISDIR.
      unlinkSync(dir);
      mkdirSync(dirname(dir), { recursive: true });
      // Copy package files only. The package directory under .pnpm has no nested
      // node_modules of its own; its deps live as sibling symlinks that we
      // materialize separately via the closure walk.
      cpSync(entry.resolvedSource, dir, { recursive: true, dereference: true });
      mutated += 1;

      // Inject only AFTER a successful real-directory replacement so restore is
      // proven against a partially-materialized workspace (not merely an unlink).
      if (failAfter?.kind === "count" && mutated >= failAfter.value) {
        const afterCopy = lstatSyncSafe(dir);
        if (!afterCopy || afterCopy.isSymbolicLink()) {
          throw new Error("injected failure precondition failed: expected a real directory after cpSync");
        }
        throw new Error(`injected mid-prepare failure after ${mutated} successful materialization(s)`);
      }
    }

    stagePublicPackageManifest(packageJsonOriginal);
    const staged = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (Object.hasOwn(staged, "devDependencies")) {
      throw new Error("public manifest staging left a devDependencies field");
    }
    if (failAfter?.kind === "public-manifest") {
      throw new Error("injected failure after public-manifest staging");
    }
  } catch (error) {
    // Best-effort rollback from the full journal (covers partial materialize
    // and public-manifest staging failures).
    try {
      restore({ allowMissing: true });
    } catch (restoreError) {
      console.error(
        `materialize-bundled-deps: restore after prepare failure also failed: ${
          restoreError instanceof Error ? restoreError.message : restoreError
        }`,
      );
    }
    fail(error instanceof Error ? error.message : String(error));
  }

  const parts = [];
  if (entries.length > 0) parts.push(`${entries.length} pack input(s) as real directories`);
  parts.push("registry-safe package.json (devDependencies stripped)");
  console.log(`materialize-bundled-deps: prepared ${parts.join("; ")}`);
}

/**
 * Idempotent restore from the journal. Restores package.json byte-for-byte when
 * present. Each symlink entry may still be a symlink (not yet mutated) or a
 * real directory (already copied); both become the recorded original symlink
 * target.
 */
function restore(options = {}) {
  if (!existsSync(MANIFEST_PATH)) {
    if (options.allowMissing === true) return;
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (typeof manifest.packageJson === "string") {
    writeFileSync(PACKAGE_JSON_PATH, manifest.packageJson);
    if (typeof manifest.packageJsonSha256 === "string") {
      const now = sha256Text(manifest.packageJson);
      if (now !== manifest.packageJsonSha256) {
        throw new Error("restore journal packageJson does not match recorded sha256");
      }
      const onDisk = sha256Text(readFileSync(PACKAGE_JSON_PATH, "utf8"));
      if (onDisk !== manifest.packageJsonSha256) {
        throw new Error("restored package.json digest mismatch");
      }
    }
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  for (const entry of entries) {
    if (typeof entry?.path !== "string" || typeof entry?.linkTarget !== "string") {
      throw new Error("restore journal entry missing path/linkTarget");
    }
    const dir = join(PACKAGE_ROOT, entry.path);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    symlinkSync(entry.linkTarget, dir);
  }
  rmSync(MANIFEST_PATH, { force: true });
  rmSync(`${MANIFEST_PATH}.${process.pid}.tmp`, { force: true });
  const restored = [];
  if (typeof manifest.packageJson === "string") restored.push("package.json");
  if (entries.length > 0) restored.push(`${entries.length} symlink(s)`);
  if (restored.length > 0) {
    console.log(`materialize-bundled-deps: restored ${restored.join(" + ")}`);
  }
}

/**
 * Regression: capture symlink targets and package.json digest, force a
 * mid-prepare failure after at least one replacement, prove every original
 * symlink and the exact package.json bytes are restored with no stranded
 * journal/real-copy, force a public-manifest staging failure and prove the
 * same, then prove a clean prepare+restore still works.
 */
function selftestRecovery() {
  const packageJsonBefore = readFileSync(PACKAGE_JSON_PATH, "utf8");
  const packageJsonDigest = sha256Text(packageJsonBefore);
  const rootPkg = JSON.parse(packageJsonBefore);
  const names = listBundleClosure(rootPkg);
  if (names.length < 2) {
    fail("selftest-recovery needs at least two bundle-closure packages to inject a mid-prepare failure");
  }
  if (!Object.hasOwn(rootPkg, "devDependencies")) {
    fail("selftest-recovery precondition failed: source package.json has no devDependencies to strip");
  }

  if (existsSync(MANIFEST_PATH)) restore({ allowMissing: true });

  /** @type {Map<string, string>} */
  const before = new Map();
  for (const name of names) {
    const dir = packageDir(name);
    const stat = lstatSyncSafe(dir);
    if (!stat?.isSymbolicLink()) {
      fail(`selftest-recovery precondition failed: ${name} is not a symlink`);
    }
    before.set(name, readlinkSync(dir));
  }

  function assertSourcePackageJsonRestored(phase) {
    const now = readFileSync(PACKAGE_JSON_PATH, "utf8");
    if (now !== packageJsonBefore || sha256Text(now) !== packageJsonDigest) {
      fail(`selftest-recovery ${phase}: source package.json was not restored byte-for-byte`);
    }
    const parsed = JSON.parse(now);
    for (const name of ["@first-tree/cloud-client", "@first-tree/client-runtime", "@first-tree/client-providers"]) {
      if (parsed.devDependencies?.[name] !== "workspace:*") {
        fail(`selftest-recovery ${phase}: missing source workspace:* for ${name}`);
      }
    }
  }

  function assertSymlinksRestored(phase) {
    for (const name of names) {
      const dir = packageDir(name);
      const stat = lstatSyncSafe(dir);
      if (!stat?.isSymbolicLink()) {
        fail(`selftest-recovery ${phase}: did not restore symlink for ${name}`);
      }
      const target = readlinkSync(dir);
      if (target !== before.get(name)) {
        fail(`selftest-recovery ${phase}: restored wrong target for ${name}: ${target} (want ${before.get(name)})`);
      }
    }
  }

  // Child fails after the first successful cpSync (real directory present) and
  // before the next entry, so restore must delete that copy and recreate every
  // original symlink from the preflight journal — and restore package.json.
  {
    const child = spawnSync(process.execPath, [THIS_SCRIPT, "prepare", "--fail-after=1"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    });
    if (child.status === 0) {
      fail("selftest-recovery expected prepare --fail-after=1 to exit non-zero");
    }
    const childOut = `${child.stdout}\n${child.stderr}`;
    if (!childOut.includes("successful materialization")) {
      fail(`selftest-recovery expected failure after a successful copy, got:\n${childOut}`);
    }
    if (existsSync(MANIFEST_PATH)) {
      fail("selftest-recovery left a stranded restore manifest after mid-prepare failure");
    }
    assertSourcePackageJsonRestored("mid-prepare failure");
    assertSymlinksRestored("mid-prepare failure");
  }

  // Child fails after public-manifest staging so restore must rewrite the
  // sanitized package.json back to the exact source bytes.
  {
    const child = spawnSync(process.execPath, [THIS_SCRIPT, "prepare", "--fail-after=public-manifest"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    });
    if (child.status === 0) {
      fail("selftest-recovery expected prepare --fail-after=public-manifest to exit non-zero");
    }
    const childOut = `${child.stdout}\n${child.stderr}`;
    if (!childOut.includes("injected failure after public-manifest staging")) {
      fail(`selftest-recovery expected public-manifest failure, got:\n${childOut}`);
    }
    if (existsSync(MANIFEST_PATH)) {
      fail("selftest-recovery left a stranded restore manifest after public-manifest failure");
    }
    assertSourcePackageJsonRestored("public-manifest failure");
    assertSymlinksRestored("public-manifest failure");
  }

  // Clean prepare + restore must still succeed after the failure paths.
  const prepareOk = spawnSync(process.execPath, [THIS_SCRIPT, "prepare"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (prepareOk.status !== 0) {
    fail(`selftest-recovery follow-up prepare failed:\n${prepareOk.stderr || prepareOk.stdout}`);
  }
  if (!existsSync(MANIFEST_PATH)) {
    fail("selftest-recovery follow-up prepare did not leave a restore manifest");
  }
  for (const name of names) {
    const dir = packageDir(name);
    if (lstatSyncSafe(dir)?.isSymbolicLink()) {
      fail(`selftest-recovery follow-up prepare left ${name} as a symlink`);
    }
  }
  const stagedPkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  if (Object.hasOwn(stagedPkg, "devDependencies")) {
    fail("selftest-recovery follow-up prepare left a public manifest with devDependencies");
  }
  for (const name of ["@first-tree/cloud-client", "@first-tree/client-runtime", "@first-tree/client-providers"]) {
    if (stagedPkg.dependencies?.[name] !== undefined) {
      fail(`selftest-recovery follow-up prepare leaked ${name} into dependencies`);
    }
  }

  const restoreOk = spawnSync(process.execPath, [THIS_SCRIPT, "restore"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (restoreOk.status !== 0) {
    fail(`selftest-recovery follow-up restore failed:\n${restoreOk.stderr || restoreOk.stdout}`);
  }
  if (existsSync(MANIFEST_PATH)) {
    fail("selftest-recovery follow-up restore left a stranded manifest");
  }
  assertSourcePackageJsonRestored("follow-up restore");
  assertSymlinksRestored("follow-up restore");

  console.log(
    `materialize-bundled-deps: selftest-recovery PASS (${names.length} symlinks + package.json restored after mid-prepare and public-manifest failures; clean prepare/restore ok)`,
  );
}

const argv = process.argv.slice(2);
const action = argv[0] ?? "prepare";
if (action === "prepare") prepare({ failAfter: parseFailAfter(argv.slice(1)) });
else if (action === "restore") restore();
else if (action === "selftest-recovery") selftestRecovery();
else fail(`unknown action '${action}' (expected prepare|restore|selftest-recovery)`);
