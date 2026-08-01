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
 * Restore puts the original symlink targets back so the pnpm workspace stays
 * consistent after a local pack. The restore manifest lives beside this package
 * and is removed on restore.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
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

function prepare() {
  if (existsSync(MANIFEST_PATH)) {
    // A previous prepare without restore (interrupted pack). Restore first so we
    // never nest a real copy on top of another real copy.
    restore({ allowMissing: true });
  }

  const rootPkg = readPackageJson(PACKAGE_ROOT);
  const names = listBundleClosure(rootPkg);
  if (names.length === 0) return;

  const entries = [];
  for (const name of names) {
    const dir = packageDir(name);
    if (!existsSync(join(dir, "package.json")) && !lstatSyncSafe(dir)?.isSymbolicLink()) {
      fail(`bundle closure package missing from node_modules: ${name}`);
    }
    const stat = lstatSyncSafe(dir);
    if (!stat) fail(`cannot stat ${name}`);
    if (!stat.isSymbolicLink()) {
      // Already a real directory (e.g. re-entrant prepare). Leave it alone.
      continue;
    }
    const linkTarget = readlinkSync(dir);
    const resolvedSource = realpathSync(dir);
    // Unlink the symlink itself — never rmSync a directory symlink without
    // care: Node may treat the target as the path and raise EISDIR.
    unlinkSync(dir);
    mkdirSync(dirname(dir), { recursive: true });
    // Copy package files only. The package directory under .pnpm has no nested
    // node_modules of its own; its deps live as sibling symlinks that we
    // materialize separately via the closure walk.
    cpSync(resolvedSource, dir, { recursive: true, dereference: true });
    entries.push({
      name,
      path: relative(PACKAGE_ROOT, dir),
      linkTarget,
    });
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
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

const action = process.argv[2] ?? "prepare";
if (action === "prepare") prepare();
else if (action === "restore") restore();
else fail(`unknown action '${action}' (expected prepare|restore)`);
