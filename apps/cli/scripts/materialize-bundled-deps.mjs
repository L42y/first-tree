#!/usr/bin/env node
/**
 * Materialize `bundleDependencies` (and the bundled packages' direct deps that
 * resolve from this package's node_modules) as real directories before `npm pack`
 * / `npm publish`.
 *
 * Why: the workspace is installed with pnpm, so `node_modules/<pkg>` entries are
 * symlinks into `node_modules/.pnpm/...`. npm 11.5.1's pack path follows those
 * links and writes tar entry names like `package/../../node_modules/.pnpm/...`.
 * The npm registry rejects that layout with E415 ("invalid path"). Replacing
 * the pack-time inputs with in-package real copies keeps every tar entry under
 * `package/` with no `..` traversal, while preserving `bundleDependencies` and
 * the patched Kimi SDK payload.
 *
 * Lifecycle:
 *   prepack  → node scripts/materialize-bundled-deps.mjs prepare
 *   postpack → node scripts/materialize-bundled-deps.mjs restore
 *
 * Recovery: each original symlink target is persisted to the restore manifest
 * *before* that link is unlinked, via an atomic rename. A mid-prepare failure
 * (or a later `prepare` that finds a stranded manifest) restores every recorded
 * target so the pnpm workspace cannot be left with unrecoverable real copies.
 */
import { spawnSync } from "node:child_process";
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

/** Persist the recovery manifest via write-temp + rename so a crash cannot leave
 * a half-written JSON that omits already-unlinked targets. */
function persistManifest(entries) {
  const tmpPath = `${MANIFEST_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  renameSync(tmpPath, MANIFEST_PATH);
}

function parseFailAfter(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fail-after") {
      const value = Number.parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 1) fail("--fail-after requires a positive integer");
      return value;
    }
    if (arg.startsWith("--fail-after=")) {
      const value = Number.parseInt(arg.slice("--fail-after=".length), 10);
      if (!Number.isFinite(value) || value < 1) fail("--fail-after requires a positive integer");
      return value;
    }
  }
  const fromEnv = process.env.MATERIALIZE_BUNDLED_DEPS_FAIL_AFTER;
  if (fromEnv !== undefined && fromEnv !== "") {
    const value = Number.parseInt(fromEnv, 10);
    if (!Number.isFinite(value) || value < 1) {
      fail("MATERIALIZE_BUNDLED_DEPS_FAIL_AFTER requires a positive integer");
    }
    return value;
  }
  return null;
}

function prepare(options = {}) {
  const failAfter = options.failAfter ?? null;

  if (existsSync(MANIFEST_PATH)) {
    // A previous prepare without restore (interrupted pack). Restore first so we
    // never nest a real copy on top of another real copy.
    restore({ allowMissing: true });
  }

  const rootPkg = readPackageJson(PACKAGE_ROOT);
  const names = listBundleClosure(rootPkg);
  if (names.length === 0) return;

  /** @type {{ name: string, path: string, linkTarget: string }[]} */
  const entries = [];
  let mutated = 0;

  try {
    for (const name of names) {
      const dir = packageDir(name);
      if (!existsSync(join(dir, "package.json")) && !lstatSyncSafe(dir)?.isSymbolicLink()) {
        throw new Error(`bundle closure package missing from node_modules: ${name}`);
      }
      const stat = lstatSyncSafe(dir);
      if (!stat) throw new Error(`cannot stat ${name}`);
      if (!stat.isSymbolicLink()) {
        // After a successful restore-at-start, every closure entry must still be
        // a symlink. A real directory here means a prior run lost its recovery
        // record — fail closed rather than skip and strand the workspace.
        throw new Error(
          `expected symlink for ${name} but found a real path; refusing to materialize without a recoverable link target`,
        );
      }

      const linkTarget = readlinkSync(dir);
      const resolvedSource = realpathSync(dir);
      const entry = {
        name,
        path: relative(PACKAGE_ROOT, dir),
        linkTarget,
      };

      // Record the original target BEFORE unlinking so any later failure in this
      // loop (or process death after the rename) can restore via the manifest.
      entries.push(entry);
      persistManifest(entries);

      // Unlink the symlink itself — never rmSync a directory symlink without
      // care: Node may treat the target as the path and raise EISDIR.
      unlinkSync(dir);
      mutated += 1;

      if (failAfter !== null && mutated >= failAfter) {
        throw new Error(`injected mid-prepare failure after ${mutated} unlink(s)`);
      }

      mkdirSync(dirname(dir), { recursive: true });
      // Copy package files only. The package directory under .pnpm has no nested
      // node_modules of its own; its deps live as sibling symlinks that we
      // materialize separately via the closure walk.
      cpSync(resolvedSource, dir, { recursive: true, dereference: true });
    }
  } catch (error) {
    // Best-effort rollback of every entry already recorded in the manifest.
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

  if (entries.length > 0) {
    console.log(`materialize-bundled-deps: prepared ${entries.length} pack input(s) as real directories`);
  }
}

function restore(options = {}) {
  if (!existsSync(MANIFEST_PATH)) {
    if (options.allowMissing === true) return;
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  for (const entry of entries) {
    const dir = join(PACKAGE_ROOT, entry.path);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    symlinkSync(entry.linkTarget, dir);
  }
  rmSync(MANIFEST_PATH, { force: true });
  if (entries.length > 0) {
    console.log(`materialize-bundled-deps: restored ${entries.length} symlink(s)`);
  }
}

/**
 * Regression: capture symlink targets, force a mid-prepare failure, prove every
 * original symlink (and the absence of a stranded manifest) is restored.
 */
function selftestRecovery() {
  const rootPkg = readPackageJson(PACKAGE_ROOT);
  const names = listBundleClosure(rootPkg);
  if (names.length < 2) {
    fail("selftest-recovery needs at least two bundle-closure packages to inject a mid-prepare failure");
  }

  // Start from a clean symlink workspace.
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

  // Run prepare in a child so process.exit from fail() does not kill this harness.
  const child = spawnSync(process.execPath, [THIS_SCRIPT, "prepare", "--fail-after=1"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (child.status === 0) {
    fail("selftest-recovery expected prepare --fail-after=1 to exit non-zero");
  }

  if (existsSync(MANIFEST_PATH)) {
    fail("selftest-recovery left a stranded restore manifest");
  }

  for (const name of names) {
    const dir = packageDir(name);
    const stat = lstatSyncSafe(dir);
    if (!stat?.isSymbolicLink()) {
      fail(`selftest-recovery did not restore symlink for ${name}`);
    }
    const target = readlinkSync(dir);
    if (target !== before.get(name)) {
      fail(`selftest-recovery restored wrong target for ${name}: ${target} (want ${before.get(name)})`);
    }
  }

  console.log(
    `materialize-bundled-deps: selftest-recovery PASS (${names.length} symlinks restored after mid-prepare failure)`,
  );
}

const argv = process.argv.slice(2);
const action = argv[0] ?? "prepare";
if (action === "prepare") prepare({ failAfter: parseFailAfter(argv.slice(1)) });
else if (action === "restore") restore();
else if (action === "selftest-recovery") selftestRecovery();
else fail(`unknown action '${action}' (expected prepare|restore|selftest-recovery)`);
