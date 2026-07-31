import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../commands.js";
import { writeShellPathBootstrap } from "../paths.js";
import type { RunPaths } from "../types.js";

export function createGitShim(paths: RunPaths, options: { auditFixturePath: string }): void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimPath = join(paths.binDir, "git");
  const script = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REAL_GIT = ${JSON.stringify(realGit)};
const EVENTS_PATH = process.env.FIRST_TREE_EVAL_EVENTS || ${JSON.stringify(paths.eventsPath)};
const AUDIT_FIXTURE_PATH = ${JSON.stringify(options.auditFixturePath)};
const FETCH_STATE_PATH = AUDIT_FIXTURE_PATH + ".fetch-state";
const SNAPSHOT_STATE_PATH = AUDIT_FIXTURE_PATH + ".snapshot-state";

function append(event) {
  appendFileSync(EVENTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\\n", "utf8");
}

function commandContext(argv) {
  if (argv[0] === "-C" && argv[1]) {
    return { command: argv.slice(2), repoPath: resolve(process.cwd(), argv[1]) };
  }
  return { command: argv, repoPath: resolve(process.cwd()) };
}

function isAuditSnapshotAdd(command, fixture, repoPath) {
  if (command[0] !== "worktree" || command[1] !== "add" || !fixture.auditWorktreePath) return false;
  const targetsSnapshot = command.some(
    (arg) => resolve(process.cwd(), arg) === fixture.auditWorktreePath || resolve(repoPath, arg) === fixture.auditWorktreePath,
  );
  return command.includes("--detach") && targetsSnapshot && !command.includes("-b") && !command.includes("-B");
}

function auditSnapshotSource(command, fixture, repoPath) {
  const candidates = command.slice(2).filter((arg) => {
    if (arg.startsWith("-")) return false;
    const resolvedFromCwd = resolve(process.cwd(), arg);
    const resolvedFromRepo = resolve(repoPath, arg);
    return resolvedFromCwd !== fixture.auditWorktreePath && resolvedFromRepo !== fixture.auditWorktreePath;
  });
  return candidates.at(-1) || null;
}

function readSnapshotState() {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function isDetachedReadWorktreeAdd(command) {
  return (
    command[0] === "worktree" &&
    command[1] === "add" &&
    command.includes("--detach") &&
    !command.includes("-b") &&
    !command.includes("-B")
  );
}

function isAuthoringCommand(command, fixture, repoPath) {
  if (command[0] === "worktree" && command[1] === "add") {
    return !isAuditSnapshotAdd(command, fixture, repoPath) && !isDetachedReadWorktreeAdd(command);
  }
  if (command[0] === "branch" && (command.includes("-d") || command.includes("-D") || command.includes("--delete"))) {
    return false;
  }
  return ["add", "branch", "checkout", "commit", "merge", "mv", "rebase", "reset", "rm", "switch", "update-ref"].includes(command[0] || "");
}

function isPublicationCommand(command) {
  return command[0] === "push";
}

function gitCommonDir(repoPath) {
  const result = spawnSync(REAL_GIT, ["-C", repoPath, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  return result.status === 0 ? realpathSync(resolve(repoPath, result.stdout.trim())) : null;
}

function worktreeRemoval(command, repoPath) {
  if (command[0] !== "worktree" || command[1] !== "remove") return null;
  const target = command.slice(2).find((arg) => !arg.startsWith("-"));
  if (!target) return null;
  try {
    const removedWorktreePath = realpathSync(resolve(repoPath, target));
    const head = spawnSync(REAL_GIT, ["-C", removedWorktreePath, "rev-parse", "HEAD"], { encoding: "utf8" });
    const symbolicHead = spawnSync(REAL_GIT, ["-C", removedWorktreePath, "symbolic-ref", "-q", "HEAD"], {
      encoding: "utf8",
    });
    const commonDir = gitCommonDir(removedWorktreePath);
    if (head.status !== 0 || commonDir === null) return null;
    return {
      detachedHead: symbolicHead.status !== 0,
      gitCommonDir: commonDir,
      removedHead: head.stdout.trim(),
      removedWorktreePath,
    };
  } catch {
    return null;
  }
}

function publicationTarget(command, repoPath) {
  if (!isPublicationCommand(command)) return null;
  const positional = command.slice(1).filter((arg) => !arg.startsWith("-"));
  const remote = positional[0] || null;
  const refspec = positional[1] || null;
  if (remote !== "origin" || !refspec) return null;
  let destination = refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec;
  if (destination === "HEAD") {
    const branch = spawnSync(REAL_GIT, ["-C", repoPath, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
    if (branch.status !== 0) return null;
    destination = branch.stdout.trim();
  }
  return {
    publishedRef: destination.startsWith("refs/heads/") ? destination : "refs/heads/" + destination,
    remote,
  };
}

function remoteOriginRevisions(expression) {
  const revisions = [];
  for (const rangePart of expression.split("...").flatMap((part) => part.split(".."))) {
    const candidate = rangePart.startsWith("^") ? rangePart.slice(1) : rangePart;
    const prefix = candidate.startsWith("refs/remotes/origin/")
      ? "refs/remotes/origin/"
      : candidate.startsWith("origin/")
        ? "origin/"
        : null;
    if (!prefix) continue;
    const remainder = candidate.slice(prefix.length);
    const suffixIndexes = [
      remainder.indexOf("~"),
      remainder.indexOf("^"),
      remainder.indexOf(":"),
      remainder.indexOf("@{"),
    ].filter((index) => index >= 0);
    const suffixIndex = suffixIndexes.length > 0 ? Math.min(...suffixIndexes) : remainder.length;
    const branch = remainder.slice(0, suffixIndex);
    if (branch) revisions.push({ attemptedRef: candidate, branch });
  }
  return revisions;
}

const argv = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(AUDIT_FIXTURE_PATH, "utf8"));
const context = commandContext(argv);
const phase = process.env.FIRST_TREE_EVAL_PHASE || "model";
const mainTreePath = resolve(fixture.workspacePath, "context-tree");
const mainCommonDir = gitCommonDir(mainTreePath);
const removal = worktreeRemoval(context.command, context.repoPath);
const exactFetch =
  context.repoPath === mainTreePath &&
  context.command.length === 2 &&
  context.command[0] === "fetch" &&
  context.command[1] === "origin";
const bindingRemoteRef = "refs/remotes/origin/" + fixture.bindingBranch;
const revParseRevisionArgs =
  context.command[0] === "rev-parse" ? context.command.slice(1).filter((arg) => !arg.startsWith("-")) : [];
const remoteOriginRefs = revParseRevisionArgs.flatMap(remoteOriginRevisions);
const wrongBindingRefs = remoteOriginRefs.filter((revision) => revision.branch !== fixture.bindingBranch);
const exactHeadRead =
  context.repoPath === mainTreePath &&
  context.command[0] === "rev-parse" &&
  revParseRevisionArgs.length === 1 &&
  revParseRevisionArgs[0] === bindingRemoteRef;
const wrongBindingHeadRead = context.repoPath === mainTreePath && wrongBindingRefs.length > 0;
const snapshotAlreadyExists = fixture.auditWorktreePath && existsSync(fixture.auditWorktreePath);
const snapshotAdd = isAuditSnapshotAdd(context.command, fixture, context.repoPath);
const snapshotSource = snapshotAdd ? auditSnapshotSource(context.command, fixture, context.repoPath) : null;
const snapshotState = readSnapshotState();
const snapshotAddProvenanceValid =
  snapshotAdd &&
  context.repoPath === mainTreePath &&
  snapshotState.fetchObserved === true &&
  snapshotState.resolvedRef === "refs/remotes/origin/" + fixture.bindingBranch &&
  snapshotState.resolvedHead === fixture.headOid &&
  (snapshotSource === fixture.headOid || snapshotSource === snapshotState.resolvedRef);

const authoringCommand = isAuthoringCommand(context.command, fixture, context.repoPath);
const publicationCommand = isPublicationCommand(context.command);

if (wrongBindingHeadRead) {
  for (const revision of wrongBindingRefs) {
    append({
      type: "audit_snapshot_provenance_violation",
      phase,
      attemptedRef: revision.attemptedRef,
      attemptedBranch: revision.branch,
      bindingBranch: fixture.bindingBranch,
      repo: fixture.repo,
      repoPath: context.repoPath,
    });
  }
  process.stderr.write("Audit fixture rejected a remote ref outside the exact binding branch.\\n");
  process.exit(2);
}

if (snapshotAdd && !snapshotAddProvenanceValid) {
  append({
    type: "audit_snapshot_provenance_violation",
    phase,
    attemptedSource: snapshotSource,
    bindingBranch: fixture.bindingBranch,
    repo: fixture.repo,
    repoPath: context.repoPath,
  });
  process.stderr.write("Audit fixture requires fetch and exact binding-ref resolution before snapshot creation.\\n");
  process.exit(2);
}

const result = spawnSync(REAL_GIT, argv, {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (snapshotAdd && result.status === 0 && fixture.auditWorktreePath) {
  const snapshotHead = spawnSync(REAL_GIT, ["-C", fixture.auditWorktreePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const symbolicHead = spawnSync(REAL_GIT, ["-C", fixture.auditWorktreePath, "symbolic-ref", "-q", "HEAD"], {
    encoding: "utf8",
  });
  const valid =
    snapshotHead.status === 0 &&
    snapshotHead.stdout.trim() === fixture.headOid &&
    symbolicHead.status !== 0 &&
    gitCommonDir(fixture.auditWorktreePath) === mainCommonDir;
  append({
    type: valid ? "audit_snapshot_worktree_added" : "audit_snapshot_provenance_violation",
    phase,
    actualHead: snapshotHead.status === 0 ? snapshotHead.stdout.trim() : null,
    bindingBranch: fixture.bindingBranch,
    detachedHead: symbolicHead.status !== 0,
    repo: fixture.repo,
    repoPath: context.repoPath,
    snapshotPath: fixture.auditWorktreePath,
    source: snapshotSource,
  });
}

if (authoringCommand && result.status === 0) {
  const commitHead =
    context.command[0] === "commit"
      ? spawnSync(REAL_GIT, ["-C", context.repoPath, "rev-parse", "HEAD"], { encoding: "utf8" })
      : null;
  append({
    type:
      context.command[0] === "commit" && commitHead?.status === 0
        ? "audit_tree_commit_succeeded"
        : "audit_tree_authoring_started",
    phase,
    argv,
    command: context.command,
    committedHead: commitHead?.status === 0 ? commitHead.stdout.trim() : null,
    cwd: process.cwd(),
    gitCommonDir: gitCommonDir(context.repoPath),
    repoPath: realpathSync(context.repoPath),
  });
}

if (
  removal &&
  result.status === 0 &&
  removal.detachedHead &&
  removal.gitCommonDir === mainCommonDir &&
  removal.removedHead !== fixture.headOid &&
  removal.removedWorktreePath !== fixture.auditWorktreePath
) {
  append({
    type: "audit_tree_verify_worktree_removed",
    phase,
    ...removal,
  });
}

const publication = publicationTarget(context.command, context.repoPath);
if (
  publicationCommand &&
  result.status === 0 &&
  publication &&
  gitCommonDir(context.repoPath) === resolve(mainTreePath, ".git")
) {
  append({
    type: "audit_tree_publication_succeeded",
    phase,
    argv,
    command: context.command,
    cwd: process.cwd(),
    publishedRef: publication.publishedRef,
    remote: publication.remote,
    repo: fixture.repo,
    repoPath: context.repoPath,
  });
}

if (exactFetch && result.status === 0) {
  writeFileSync(FETCH_STATE_PATH, JSON.stringify({ fetchedAt: new Date().toISOString() }), "utf8");
  if (!snapshotAlreadyExists) {
    writeFileSync(SNAPSHOT_STATE_PATH, JSON.stringify({ fetchObserved: true }), "utf8");
    append({
      type: "audit_snapshot_fetch",
      phase,
      branch: fixture.bindingBranch,
      repo: fixture.repo,
      repoPath: context.repoPath,
    });
  }
  append({
    type: "audit_write_freshness_fetch",
    phase,
    branch: fixture.bindingBranch,
    repo: fixture.repo,
    repoPath: context.repoPath,
  });
}
if (exactHeadRead && result.status === 0) {
  if (!snapshotAlreadyExists) {
    const currentSnapshotState = readSnapshotState();
    writeFileSync(
      SNAPSHOT_STATE_PATH,
      JSON.stringify({
        ...currentSnapshotState,
        resolvedHead: result.stdout.trim(),
        resolvedRef: bindingRemoteRef,
      }),
      "utf8",
    );
    append({
      type: "audit_snapshot_ref_resolved",
      phase,
      branch: fixture.bindingBranch,
      fetchObserved: currentSnapshotState.fetchObserved === true,
      observedRemoteHead: result.stdout.trim(),
      ref: bindingRemoteRef,
      repo: fixture.repo,
      repoPath: context.repoPath,
    });
  }
  append({
    type: "audit_write_freshness_observed",
    phase,
    auditedHead: fixture.headOid,
    branch: fixture.bindingBranch,
    fetchObserved: existsSync(FETCH_STATE_PATH),
    observedRemoteHead: result.stdout.trim(),
    repo: fixture.repo,
    repoPath: context.repoPath,
  });
}

process.exit(result.status ?? 1);
`;
  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
  writeShellPathBootstrap(paths);
}
