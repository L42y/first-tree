#!/usr/bin/env node
// Copy the canonical skill payloads from the repo-root `skills/` directory
// (plus the privately registered variants under `skill-variants/`) into a
// packaging target. Every write goes through a verified, unforgeable target
// capability that lives only for the duration of a `withTrustedSkillsTarget`
// transaction: the trusted parent and the three source roots are held open as
// non-following directory file descriptors whose fstat identity is pinned
// into the capability, so a deleted directory can never be replaced by
// another object that reuses its identity while the capability is alive.
// Arbitrary paths — absolute, `..`, symlinked, or pointing at protected
// roots — are rejected before the first mutation.
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILL_PAYLOAD_REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** Single registry used by client prebuild, CLI prepack, and portable builds. */
export const PRIVATE_SKILL_VARIANTS = Object.freeze({
  "local-context": Object.freeze(["first-tree-read", "first-tree-write"]),
});

// Open directories without following a final-component symlink; the flags are
// POSIX and present on the macOS/Linux release matrix, and degrade to a plain
// read-only open where a platform does not define them.
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

// Module-private capability state. WeakSet membership marks a capability as
// live inside its transaction; the WeakMap holds the open fd guards. Neither
// is exposed on the capability object, and membership is revoked when the
// transaction ends, so escaped, copied, spread, or rebuilt plain objects can
// never pass — there is no exported symbol or shape to forge.
const TRUSTED_SKILLS_TARGETS = new WeakSet();
const TRUSTED_SKILLS_HANDLES = new WeakMap();

function fail(message) {
  throw new Error(message);
}

function directoryNames(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function assertExactNames(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must contain exactly: ${expected.join(", ")}; found: ${actual.join(", ")}`);
  }
}

export function privateSkillVariantEntries() {
  return Object.entries(PRIVATE_SKILL_VARIANTS).flatMap(([variant, names]) => names.map((name) => ({ variant, name })));
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// Walk every existing lexical component of an absolute path and refuse any
// symlink. Canonicalization alone is not enough here: a caller-supplied alias
// that merely resolves somewhere safe must fail, not be silently accepted.
function assertNoSymlinkComponents(absolutePath) {
  const { root } = parse(absolutePath);
  let current = root;
  for (const part of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      continue; // not created yet; nothing to trust or reject
    }
    if (stats.isSymbolicLink()) {
      fail(`Refusing skills target path with symlink component: ${current}`);
    }
  }
}

function isFirstTreeWorkspaceRoot(dir) {
  return existsSync(join(dir, ".first-tree-workspace")) || existsSync(join(dir, ".first-tree"));
}

// Distinguish "genuinely absent" from "dangling symlink": existsSync follows
// links and reports false for a dangling one, which would let a hostile link
// be treated as missing and then mutated through. lstat never follows.
function lstatIfPresent(path) {
  return lstatSync(path, { throwIfNoEntry: false });
}

// Close every guard in reverse order, always attempting all of them. Returns
// the first close error (if any) so callers can surface it instead of
// silently dropping a failed close — handles are fully module-private, so a
// close error is never expected on a healthy path.
function closeDirectoryGuards(guards) {
  let firstError = null;
  for (const guard of [...guards].reverse()) {
    try {
      closeSync(guard.fd);
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

// Combine a primary failure (which may be any thrown value, including
// non-Error or falsy ones) with a handle close failure without assuming the
// primary has a `.message`. When nothing went wrong during close the primary
// value is returned unchanged so callers can rethrow it exactly.
function aggregateCloseError(primary, closeError) {
  if (closeError === null || closeError === undefined) {
    return primary;
  }
  return new AggregateError(
    [primary, closeError],
    "Skills target operation failed and closing its directory handles also failed",
  );
}

// Open each directory with O_DIRECTORY|O_NOFOLLOW and pin the fstat identity
// of the opened object — the identity recorded later must come from the open
// guard itself, not from a closed stat taken before the open. On any failure
// every already-opened fd is closed in reverse order.
function openDirectoryGuards(paths) {
  const guards = [];
  try {
    for (const path of paths) {
      const fd = openSync(path, DIRECTORY_OPEN_FLAGS);
      try {
        const stats = fstatSync(fd);
        if (!stats.isDirectory()) {
          fail(`Skills directory guard is not a directory: ${path}`);
        }
        guards.push({ path, fd, dev: stats.dev, ino: stats.ino });
      } catch (error) {
        try {
          closeSync(fd);
        } catch (closeError) {
          throw aggregateCloseError(error, closeError);
        }
        throw error;
      }
    }
    return guards;
  } catch (error) {
    throw aggregateCloseError(error, closeDirectoryGuards(guards));
  }
}

/**
 * Verify the caller-supplied trusted parent and source repo, and return the
 * lexical plan for the only allowed skills target beneath the parent plus the
 * identities of every directory the transaction must hold open. Performs no
 * mutation and opens no handles.
 */
function planTrustedSkillsTarget({
  repoRoot = SKILL_PAYLOAD_REPO_ROOT,
  trustedParentDir,
  additionalProtectedParents = [],
}) {
  if (typeof trustedParentDir !== "string" || !isAbsolute(trustedParentDir)) {
    fail(`Trusted parent directory must be an absolute path: ${String(trustedParentDir)}`);
  }
  if (trustedParentDir.split(/[\\/]+/).includes("..")) {
    fail(`Trusted parent directory must be canonical (no ".." segment): ${trustedParentDir}`);
  }
  const parent = resolve(trustedParentDir);
  assertNoSymlinkComponents(parent);
  const parentEntry = lstatIfPresent(parent);
  if (!parentEntry || parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
    fail(`Trusted parent directory is missing or not a real directory: ${parent}`);
  }
  const canonicalParent = realpathSync(parent);
  // Validate the source repo with the same lstat discipline, never
  // symlink-following existsSync/statSync: repoRoot and its two source roots
  // must be existing real non-symlink directories. Record canonical path +
  // dev/ino for each; the transaction then holds each one open so those
  // identities cannot be recycled underneath the capability.
  if (typeof repoRoot !== "string" || !isAbsolute(repoRoot) || repoRoot.split(/[\\/]+/).includes("..")) {
    fail(`Source repo root must be a canonical absolute path: ${String(repoRoot)}`);
  }
  // The lexical repoRoot gets the same symlink-component rejection as the
  // trusted parent, and the resolved path must be its own canonical realpath —
  // an alias through a symlinked ancestor is not an acceptable source root.
  const resolvedRepoRoot = resolve(repoRoot);
  assertNoSymlinkComponents(resolvedRepoRoot);
  const sourceIdentity = (label, path) => {
    const entry = lstatIfPresent(path);
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
      fail(`Source ${label} is missing or not a real directory: ${path}`);
    }
    return Object.freeze({ path: realpathSync(path), dev: entry.dev, ino: entry.ino });
  };
  const repoRootIdentity = sourceIdentity("repo root", resolvedRepoRoot);
  if (repoRootIdentity.path !== resolvedRepoRoot) {
    fail(`Source repo root must resolve to its canonical path: ${repoRoot}`);
  }
  const canonicalRepoRoot = repoRootIdentity.path;
  const sourceSkillsIdentity = sourceIdentity("skills root", join(canonicalRepoRoot, "skills"));
  const sourceVariantsIdentity = sourceIdentity("variants root", join(canonicalRepoRoot, "skill-variants"));
  const protectedParents = new Set(
    [
      parse(canonicalParent).root,
      safeRealpath(homedir()),
      canonicalRepoRoot,
      sourceSkillsIdentity.path,
      sourceVariantsIdentity.path,
      ...additionalProtectedParents.map((entry) => safeRealpath(resolve(entry))),
    ].filter(Boolean),
  );
  if (protectedParents.has(canonicalParent)) {
    fail(`Refusing protected skills target parent: ${canonicalParent}`);
  }
  if (isFirstTreeWorkspaceRoot(canonicalParent)) {
    fail(`Refusing First Tree workspace root as skills target parent: ${canonicalParent}`);
  }
  const targetSkillsRoot = join(canonicalParent, "skills");
  const targetEntry = lstatIfPresent(targetSkillsRoot);
  if (targetEntry && (targetEntry.isSymbolicLink() || !targetEntry.isDirectory())) {
    fail(`Refusing skills target that is not a real directory: ${targetSkillsRoot}`);
  }
  // Component-aware containment (path.relative, never string prefixes): the
  // target must not equal/contain the source repo root, and must not overlap
  // either source root in either direction. Only a complete `..` component
  // means "outside" — a child legitimately named `..repo` must still count
  // as inside. In-repo targets such as `apps/cli/skills` and
  // `packages/client/skills` remain allowed.
  const isSameOrInside = (ancestor, descendant) => {
    const rel = relative(ancestor, descendant);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  if (isSameOrInside(targetSkillsRoot, canonicalRepoRoot)) {
    fail(`Refusing skills target that equals or contains the source repo root: ${targetSkillsRoot}`);
  }
  for (const source of [sourceSkillsIdentity, sourceVariantsIdentity]) {
    if (isSameOrInside(targetSkillsRoot, source.path) || isSameOrInside(source.path, targetSkillsRoot)) {
      fail(`Refusing skills target overlapping a source directory: ${targetSkillsRoot} <-> ${source.path}`);
    }
  }
  // The target `skills` directory itself is NOT pinned: wiping and recreating
  // it is the legitimate purpose of the copy. Return the lexical plan plus
  // the closed-stat identities to compare against the opened fd guards; the
  // capability built afterwards records the fstat identity of the open
  // objects, never these pre-open values.
  const parentStats = lstatSync(canonicalParent);
  const expectedIdentities = [
    { path: canonicalParent, dev: parentStats.dev, ino: parentStats.ino },
    repoRootIdentity,
    sourceSkillsIdentity,
    sourceVariantsIdentity,
  ];
  return {
    targetSkillsRoot,
    canonicalParent,
    canonicalRepoRoot,
    sourceSkillsRoot: sourceSkillsIdentity.path,
    sourceVariantsRoot: sourceVariantsIdentity.path,
    expectedIdentities,
    handlePaths: expectedIdentities.map((entry) => entry.path),
  };
}

/**
 * Run `callback` with a verified, unforgeable skills-target capability. The
 * trusted parent and all three source roots are opened as non-following
 * directory fds for the whole callback, and the capability records the fstat
 * identity of those open objects: while a guard is open its inode cannot be
 * recycled, so a delete + same-path recreate always yields a different
 * dev/ino than the pinned identity and the pre-mutation re-check fails
 * closed. Guards are closed in reverse order and the capability is revoked
 * whether the callback returns or throws; a close error is surfaced, never
 * swallowed. The transaction is synchronous — a thenable callback result is
 * rejected after the capability has already been revoked.
 */
export function withTrustedSkillsTarget(options, callback) {
  if (typeof callback !== "function") {
    fail("withTrustedSkillsTarget requires a callback");
  }
  const plan = planTrustedSkillsTarget(options);
  const guards = openDirectoryGuards(plan.handlePaths);
  // The object opened must be the object verified: a rename/recreate/symlink
  // swap between planning and open changes dev/ino and fails closed here.
  try {
    for (let index = 0; index < guards.length; index += 1) {
      const expected = plan.expectedIdentities[index];
      const guard = guards[index];
      if (guard.dev !== expected.dev || guard.ino !== expected.ino) {
        fail(`Skills directory changed between verification and open: ${guard.path}`);
      }
    }
  } catch (error) {
    throw aggregateCloseError(error, closeDirectoryGuards(guards));
  }
  const capability = Object.freeze({
    targetSkillsRoot: plan.targetSkillsRoot,
    canonicalParent: plan.canonicalParent,
    parentDev: guards[0].dev,
    parentIno: guards[0].ino,
    canonicalRepoRoot: plan.canonicalRepoRoot,
    sourceSkillsRoot: plan.sourceSkillsRoot,
    sourceVariantsRoot: plan.sourceVariantsRoot,
    sourceIdentities: Object.freeze(
      guards.slice(1).map((guard) => Object.freeze({ path: guard.path, dev: guard.dev, ino: guard.ino })),
    ),
  });
  TRUSTED_SKILLS_HANDLES.set(capability, guards);
  TRUSTED_SKILLS_TARGETS.add(capability);
  let result;
  // Track thrown-ness separately from the thrown value: JavaScript allows
  // `throw undefined` / `throw null` / other falsy values, and every one of
  // them must propagate exactly — never be mistaken for a clean return.
  let callbackThrew = false;
  let callbackThrown;
  try {
    result = callback(capability);
  } catch (thrown) {
    callbackThrew = true;
    callbackThrown = thrown;
  }
  TRUSTED_SKILLS_TARGETS.delete(capability);
  TRUSTED_SKILLS_HANDLES.delete(capability);
  const closeError = closeDirectoryGuards(guards);
  if (callbackThrew) {
    throw aggregateCloseError(callbackThrown, closeError);
  }
  if (closeError) {
    throw closeError;
  }
  if (result && typeof result.then === "function") {
    fail("withTrustedSkillsTarget is synchronous; the callback must not return a Promise or thenable");
  }
  return result;
}

// Re-check a capability immediately before every mutation: it must be a live
// capability inside its transaction (escaped/closed/clone/raw objects fail),
// its parent and bound source roots must still be the exact same directories
// (canonical path plus dev/ino — sound because the transaction holds those
// directories open), and the target must still be absent or a real directory
// (never a symlink swapped in after verification).
function assertVerifiedSkillsTarget(target) {
  if (!target || !TRUSTED_SKILLS_TARGETS.has(target) || !TRUSTED_SKILLS_HANDLES.has(target)) {
    fail("Skills target is not a live capability from an active withTrustedSkillsTarget() transaction");
  }
  const { canonicalParent, targetSkillsRoot } = target;
  const parentEntry = lstatIfPresent(canonicalParent);
  if (!parentEntry || parentEntry.isSymbolicLink() || realpathSync(canonicalParent) !== canonicalParent) {
    fail(`Skills target parent no longer matches the verified directory: ${canonicalParent}`);
  }
  if (parentEntry.dev !== target.parentDev || parentEntry.ino !== target.parentIno) {
    fail(`Skills target parent no longer matches the verified directory identity: ${canonicalParent}`);
  }
  // The bound source repo must still be the exact same directories (canonical
  // path, non-symlink, dev/ino) — a same-path real-directory replacement or a
  // symlink swap of any source root invalidates the whole capability.
  for (const source of target.sourceIdentities) {
    const entry = lstatIfPresent(source.path);
    if (
      !entry ||
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      realpathSync(source.path) !== source.path ||
      entry.dev !== source.dev ||
      entry.ino !== source.ino
    ) {
      fail(`Skills source directory no longer matches the verified identity: ${source.path}`);
    }
  }
  const targetEntry = lstatIfPresent(targetSkillsRoot);
  if (targetEntry && (targetEntry.isSymbolicLink() || !targetEntry.isDirectory())) {
    fail(`Skills target is no longer a real directory: ${targetSkillsRoot}`);
  }
  return targetSkillsRoot;
}

// The `.variants` child is a destructive target too (the variants copy wipes
// and recreates it). Before any mutation it must be absent or a real
// directory — never a symlink (live or dangling) or special file that would
// redirect the wipe.
function assertVariantsChildSafe(targetSkillsRoot) {
  const targetVariantsRoot = join(targetSkillsRoot, ".variants");
  const stats = lstatIfPresent(targetVariantsRoot);
  if (!stats) {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(`Refusing skills variants target that is not a real directory: ${targetVariantsRoot}`);
  }
}

/** Wipe + recreate the verified skills target directory (cap-only reset). */
export function resetSkillsTarget(target) {
  const targetSkillsRoot = assertVerifiedSkillsTarget(target);
  rmSync(targetSkillsRoot, { recursive: true, force: true });
  mkdirSync(targetSkillsRoot, { recursive: true });
  return targetSkillsRoot;
}

export function copyPrivateSkillVariants(options = {}) {
  if ("repoRoot" in Object(options)) {
    fail("repoRoot is bound into the verified capability; pass only { target }");
  }
  const { target } = options;
  const targetSkillsRoot = assertVerifiedSkillsTarget(target);
  const { sourceVariantsRoot } = target;
  const variantsEntry = lstatIfPresent(sourceVariantsRoot);
  if (!variantsEntry || variantsEntry.isSymbolicLink() || !variantsEntry.isDirectory()) {
    fail(`Source skill variants directory missing: ${sourceVariantsRoot}`);
  }

  const expectedVariants = Object.keys(PRIVATE_SKILL_VARIANTS).sort();
  assertExactNames("Private Skill variant registry", directoryNames(sourceVariantsRoot), expectedVariants);
  // No outer existsSync gate: the preflight itself distinguishes absent from
  // dangling symlink, so it must run unconditionally before any mutation.
  assertVariantsChildSafe(targetSkillsRoot);
  mkdirSync(targetSkillsRoot, { recursive: true });
  const targetVariantsRoot = join(targetSkillsRoot, ".variants");
  rmSync(targetVariantsRoot, { recursive: true, force: true });
  mkdirSync(targetVariantsRoot, { recursive: true });

  let copied = 0;
  for (const [variant, names] of Object.entries(PRIVATE_SKILL_VARIANTS)) {
    const sourceVariantRoot = resolve(sourceVariantsRoot, variant);
    const expectedNames = [...names].sort();
    assertExactNames(`Skill variant ${variant}`, directoryNames(sourceVariantRoot), expectedNames);
    for (const name of names) {
      cpSync(resolve(sourceVariantRoot, name), resolve(targetVariantsRoot, variant, name), { recursive: true });
      copied += 1;
    }
  }
  return copied;
}

export function copyAllSkillPayloads(options = {}) {
  if ("repoRoot" in Object(options)) {
    fail("repoRoot is bound into the verified capability; pass only { target, clean }");
  }
  const { target, clean = false } = options;
  const targetSkillsRoot = assertVerifiedSkillsTarget(target);
  const { sourceSkillsRoot } = target;
  const skillsEntry = lstatIfPresent(sourceSkillsRoot);
  if (!skillsEntry || skillsEntry.isSymbolicLink() || !skillsEntry.isDirectory()) {
    fail(`Source skills directory missing: ${sourceSkillsRoot}`);
  }
  if (sourceSkillsRoot === targetSkillsRoot) {
    fail(`Refusing source skills directory identical to the target: ${targetSkillsRoot}`);
  }
  // Detect an illegal `.variants` child before any public copy or clean wipe,
  // so a `clean:false` run cannot partially write before failing. No outer
  // existsSync gate — the preflight itself handles absent vs dangling.
  if (!clean) {
    assertVariantsChildSafe(targetSkillsRoot);
  }
  if (clean) rmSync(targetSkillsRoot, { recursive: true, force: true });
  cpSync(sourceSkillsRoot, targetSkillsRoot, { recursive: true });
  const publicCount = directoryNames(sourceSkillsRoot).length;
  const variantCount = copyPrivateSkillVariants({ target });
  return { publicCount, variantCount };
}

function parseArgs(argv) {
  let target = null;
  let clean = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      target = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--clean") {
      clean = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  if (!target) fail("--target is required");
  return { target, clean };
}

// The CLI exists solely for the apps/cli prepack step. It only accepts the
// literal string `skills` as --target while running from the canonical
// apps/cli package directory — any other value (absolute, `..`, `./skills`,
// `foo/../skills`, another leaf) or any other cwd fails before the first
// mutation.
function resolveCliTrustedParent(target) {
  if (target !== "skills") {
    fail(`--target must be the literal "skills": ${target}`);
  }
  const canonicalCwd = realpathSync(process.cwd());
  const canonicalCliPackage = realpathSync(join(SKILL_PAYLOAD_REPO_ROOT, "apps", "cli"));
  if (canonicalCwd !== canonicalCliPackage) {
    fail(`copy-skill-payloads CLI may only run from ${canonicalCliPackage}; current directory: ${canonicalCwd}`);
  }
  return canonicalCliPackage;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const trustedParentDir = resolveCliTrustedParent(options.target);
    const result = withTrustedSkillsTarget({ trustedParentDir }, (target) => ({
      ...copyAllSkillPayloads({ target, clean: options.clean }),
      targetSkillsRoot: target.targetSkillsRoot,
    }));
    process.stdout.write(
      `copy-skill-payloads: copied ${result.publicCount} public skill(s) + ${result.variantCount} private variant(s) → ${result.targetSkillsRoot}\n`,
    );
  } catch (error) {
    process.stderr.write(`copy-skill-payloads: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
