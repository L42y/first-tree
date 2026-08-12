import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { appendEvent, previewText } from "../../core/events.js";
import { runFixtureVerify } from "../../core/fixture-verify.js";
import type { EvalReporter } from "../../core/reporter.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { CommandResult, RunPaths } from "../../core/types.js";
import type { FirstTreeWriteEvalCase, FixtureValidation, TreeArtifactBaseline } from "./types.js";

const SKILL_NAME = "first-tree-write";

function rootNodeMarkdown(): string {
  return `---
title: "First Tree Write Eval Context"
owners: [eval-owner]
---

# First Tree Write Eval Context

This deterministic Context Tree fixture is used to evaluate first-tree-write.
`;
}

function systemNodeMarkdown(): string {
  return `---
title: "System"
owners: [eval-owner]
---

# System

System-level durable constraints for the eval fixture.
`;
}

function contextManagementNodeMarkdown(): string {
  return `---
title: "Context Management"
owners: [eval-owner]
---

# Context Management

Context Tree and skill-eval decisions for the eval fixture.
`;
}

function skillEvalNodeMarkdown(): string {
  return `---
title: "Skill Eval Framework"
owners: [eval-owner]
description: "Durable constraints for First Tree skill evals."
---

# Skill Eval Framework

## Decision

First Tree uses a small skill eval framework to evaluate shipped skills with
live agent behavior in isolated workspaces.

## Rationale

Agent-backed behavior cannot be made deterministic like ordinary code, so the
framework records evidence from representative runs instead of pretending those
flows are unit tests.

## Constraints

- Default test commands do not run live model evals.
- Eval workspaces keep the source repo and Context Tree repo separate.
`;
}

function memberNodeMarkdown(): string {
  return `---
title: "eval-owner"
owners: [eval-owner]
type: human
role: "Evaluation fixture owner"
domains:
  - "context management"
---

# eval-owner

Owns the deterministic write eval fixture.
`;
}

function treeAgentsMarkdown(): string {
  return `# Eval Context Tree

This is a local deterministic Context Tree fixture for first-tree-write skill
evaluations.
`;
}

function workspaceAgentsMarkdown(
  skillDescription: string,
  treeState: FirstTreeWriteEvalCase["fixture"]["treeState"],
): string {
  const treeLine =
    treeState === "unbound" || treeState === "explicitly-unbound-with-stale-checkout"
      ? "This briefing was generated without a bound Context Tree — a supported state, not a gap to fix. Ordinary tasks proceed from the user's messages, chat context, and local inputs with no prompt to bind or create a tree. Only an explicit Tree write request names that specific capability impact: state that the write cannot be completed because no Tree is bound, without bind/create guidance."
      : treeState === "unresolved"
        ? "The Context Tree binding could not be confirmed when this briefing was generated — the server was unreachable or returned an invalid binding. This is not a confirmed unbind. Ordinary tasks proceed from the user's messages, chat context, and local inputs with no prompt to bind or create a tree. Only an explicit Tree write request names that specific capability impact: state that the write cannot be completed right now because the binding could not be confirmed, without claiming that no Tree is bound and without bind/create guidance."
        : "The Context Tree is at `./context-tree`.";

  return `# Eval Workspace Instructions

Use installed skills only when the skill description applies to the user's
prompt.

## Available Skills

| Skill | Load when |
|---|---|
| \`first-tree-write\` | ${skillDescription} |

When \`first-tree-write\` applies, load it by reading
\`.agents/skills/first-tree-write/SKILL.md\` before acting. Follow the loaded
skill workflow exactly.

## Context Tree Policy

The tree records durable decisions, constraints, ownership, and cross-domain
relationships; source repos record implementation detail. Use the Double Test:
a candidate belongs only when it establishes or changes a decision future
agents must respect and remains durable if the triggering commit or PR is
rewritten. Capture current truth and rationale, not history, PR references, or
actionable future work. Normal tree content is canonical; archive/supporting
and member content are non-normal classes with narrower authority.

${treeLine} Source artifacts, when present, are
under \`./source-artifacts\`. Do not create pull requests or push to any remote
inside this eval workspace.
`;
}

function durableSourceMarkdown(): string {
  return `# Source Artifact: Skill Eval Gate Policy

This design note records a durable decision for the First Tree skill eval
framework.

## Durable Decision

The skill eval framework separates deterministic gate checks from optional
quality judges. Hard risk boundaries such as missing source artifacts,
forbidden tree side effects, and verify failures are deterministic gate checks.
Subjective content quality belongs to an explicit quality eval.

## Rationale

Default PR gates must stay stable and explainable. LLM-as-judge can help detect
quality regressions, but it must not hide hard risk failures behind a score.

## Constraint

The default write gate must not invoke LLM-as-judge. Quality judge runs only
when an explicit quality command or periodic quality run asks for it.

Do not record this source file name, a PR id, or a delivery history in the
Context Tree node.
`;
}

function implementationOnlySourceMarkdown(): string {
  return `# Source Artifact: Implementation-only diff

The following source material is implementation detail only. It does not record
a durable decision or rationale.

\`\`\`diff
- function createWriteRunner(options: RunnerOptions): Promise<Result>
+ function createFirstTreeWriteRunner(options: RunnerOptions): Promise<Result>

- interface EvalCase { id: string; }
+ interface EvalCase { id: string; tags: string[]; }

+ GET /api/internal/evals/:id returns raw JSON for debugging.
\`\`\`

The change is a local refactor of names, interface shape, and one debug route.
No cross-domain decision was made.
`;
}

function installFirstTreeWriteSkill(
  repoRoot: string,
  workspacePath: string,
  treeState: FirstTreeWriteEvalCase["fixture"]["treeState"],
): void {
  const skillMarkdown = installRepoSkill(repoRoot, workspacePath, SKILL_NAME);
  writeText(join(workspacePath, "AGENTS.md"), workspaceAgentsMarkdown(parseSkillDescription(skillMarkdown), treeState));
}

function writeWorkspaceManifest(paths: RunPaths): void {
  writeText(
    join(paths.workspacePath, ".first-tree", "workspace.json"),
    `${JSON.stringify({ sources: ["source-repo"], tree: "context-tree" }, null, 2)}\n`,
  );
}

function writeSourceArtifacts(evalCase: FirstTreeWriteEvalCase, paths: RunPaths): void {
  const sourceDir = join(paths.workspacePath, "source-artifacts");
  mkdirSync(sourceDir, { recursive: true });

  if (evalCase.fixture.sourceArtifact === "durable-decision-note") {
    writeText(join(sourceDir, "durable-decision-note.md"), durableSourceMarkdown());
  }
  if (evalCase.fixture.sourceArtifact === "implementation-only-diff") {
    writeText(join(sourceDir, "implementation-only-diff.md"), implementationOnlySourceMarkdown());
  }
}

function writeSourceRepoFixture(paths: RunPaths): void {
  const sourceRepoPath = join(paths.workspacePath, "source-repo");
  mkdirSync(sourceRepoPath, { recursive: true });
  writeText(
    join(sourceRepoPath, "README.md"),
    "# Source Repo\n\nThis fixture should remain unchanged by first-tree-write eval cases.\n",
  );
  assertCommandOk(runCommand("git", ["init", "--initial-branch=main"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "user.name", "First Tree Eval"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["add", "."], sourceRepoPath));
  assertCommandOk(runCommand("git", ["commit", "-m", "chore: seed source fixture"], sourceRepoPath));
}

function writeContextTreeFixture(paths: RunPaths): string {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  mkdirSync(contextTreePath, { recursive: true });

  writeText(join(contextTreePath, ".first-tree", "VERSION"), "0.7.0\n");
  writeText(
    join(contextTreePath, ".first-tree", "tree.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        treeId: "first-tree-write-eval",
        treeMode: "dedicated",
        treeRepoName: "context-tree",
      },
      null,
      2,
    )}\n`,
  );
  writeText(join(contextTreePath, "AGENTS.md"), treeAgentsMarkdown());
  writeText(join(contextTreePath, "NODE.md"), rootNodeMarkdown());
  writeText(join(contextTreePath, "system", "NODE.md"), systemNodeMarkdown());
  writeText(join(contextTreePath, "system", "context-management", "NODE.md"), contextManagementNodeMarkdown());
  writeText(join(contextTreePath, "system", "context-management", "skill-eval-framework.md"), skillEvalNodeMarkdown());
  writeText(join(contextTreePath, "members", "eval-owner", "NODE.md"), memberNodeMarkdown());

  initializeGitRepo(paths, contextTreePath);
  return contextTreePath;
}

function initializeGitRepo(paths: RunPaths, contextTreePath: string): void {
  const originPath = join(paths.runRoot, "context-tree-origin.git");
  const commands: CommandResult[] = [
    runCommand("git", ["init", "--initial-branch=main"], contextTreePath),
    runCommand("git", ["config", "user.email", "eval@example.invalid"], contextTreePath),
    runCommand("git", ["config", "user.name", "First Tree Eval"], contextTreePath),
    runCommand("git", ["config", "commit.gpgsign", "false"], contextTreePath),
    runCommand("git", ["add", "."], contextTreePath),
    runCommand("git", ["commit", "-m", "chore: seed eval context tree"], contextTreePath),
    runCommand("git", ["init", "--bare", originPath], paths.runRoot),
    runCommand("git", ["remote", "add", "origin", originPath], contextTreePath),
    runCommand("git", ["push", "-u", "origin", "main"], contextTreePath),
  ];

  for (const result of commands) {
    assertCommandOk(result);
  }
}

export function setupFixture(evalCase: FirstTreeWriteEvalCase, paths: RunPaths, reporter: EvalReporter): string | null {
  const treeState = evalCase.fixture.treeState;
  const unbound = treeState === "unbound" || treeState === "explicitly-unbound-with-stale-checkout";
  const staleCheckoutResidue = treeState === "explicitly-unbound-with-stale-checkout";
  const workspaceKind = treeState === "populated" ? "context-tree" : treeState;
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    sourceArtifact: evalCase.fixture.sourceArtifact,
    treeState,
    type: "fixture_setup_started",
    workspaceKind,
  });
  reporter.fixtureSetupStarted(workspaceKind);

  installFirstTreeWriteSkill(paths.repoRoot, paths.workspacePath, treeState);
  // Match the real managed runtime: no bound Tree means no workspace manifest
  // and no declared source repo at all, never a `tree: null` placeholder. An
  // unresolved binding instead keeps the last-known manifest, source repo, and
  // Tree checkout on disk — the model must not trust them.
  if (!unbound) {
    writeWorkspaceManifest(paths);
    writeSourceRepoFixture(paths);
  }
  writeSourceArtifacts(evalCase, paths);
  const contextTreePath = unbound ? null : writeContextTreeFixture(paths);
  if (staleCheckoutResidue) {
    // Explicit unbind retires the manifest but BY DESIGN keeps the clean Tree
    // checkout as inert residue. It is written here but deliberately NOT
    // returned: this run has no active binding, so the residue is never Tree
    // authority — only a baseline the run must leave byte-identical.
    writeContextTreeFixture(paths);
  }

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    contextTreePath,
    type: "fixture_setup_finished",
    workspaceKind,
  });
  reporter.fixtureSetupFinished(workspaceKind, contextTreePath);

  return contextTreePath;
}

function fingerprintDirectory(root: string): string | null {
  if (!existsSync(root)) return null;
  const entries: string[] = [];
  function walk(dir: string): void {
    let children: string[] = [];
    try {
      children = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of children) {
      if (entry === ".git" || entry === "node_modules") continue;
      const child = join(dir, entry);
      try {
        if (statSync(child).isDirectory()) {
          walk(child);
          continue;
        }
      } catch {
        continue;
      }
      const relPath = relative(root, child).replace(/\\/gu, "/");
      const digest = createHash("sha256").update(readFileSync(child)).digest("hex");
      entries.push(`${relPath}\0${digest}`);
    }
  }
  walk(root);
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

/**
 * Pre-run record of the workspace manifest and Tree checkout state. Snapshot
 * it right after fixture setup; the post-run comparison treats whatever it
 * captured as the legal baseline.
 */
export function snapshotTreeArtifactBaseline(workspacePath: string): TreeArtifactBaseline {
  const manifestPath = join(workspacePath, ".first-tree", "workspace.json");
  return {
    checkoutFingerprint: fingerprintDirectory(join(workspacePath, "context-tree")),
    manifestContent: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null,
  };
}

/**
 * PRE/POST artifact guard: a violation is a manifest or checkout NEWLY
 * created by the run, or a pre-existing stale manifest/checkout MODIFIED
 * (including deleted) by the run. A clean checkout left by a retired binding
 * never trips this guard on its own.
 */
export function treeArtifactBaselineViolation(
  baseline: TreeArtifactBaseline,
  workspacePath: string,
): { created: boolean; modified: boolean } {
  const current = snapshotTreeArtifactBaseline(workspacePath);
  return {
    created:
      (baseline.manifestContent === null && current.manifestContent !== null) ||
      (baseline.checkoutFingerprint === null && current.checkoutFingerprint !== null),
    modified:
      (baseline.manifestContent !== null && current.manifestContent !== baseline.manifestContent) ||
      (baseline.checkoutFingerprint !== null && current.checkoutFingerprint !== baseline.checkoutFingerprint),
  };
}

function requiredTreeFiles(contextTreePath: string): readonly string[] {
  return [
    join(contextTreePath, ".first-tree", "VERSION"),
    join(contextTreePath, ".first-tree", "tree.json"),
    join(contextTreePath, "NODE.md"),
    join(contextTreePath, "system", "NODE.md"),
    join(contextTreePath, "system", "context-management", "NODE.md"),
    join(contextTreePath, "system", "context-management", "skill-eval-framework.md"),
    join(contextTreePath, "members", "eval-owner", "NODE.md"),
  ];
}

export function validateFixture(
  paths: RunPaths,
  contextTreePath: string | null,
  caseId: string,
  verbose: boolean,
  reporter: EvalReporter,
): FixtureValidation {
  if (contextTreePath === null) {
    reporter.fixtureValidationSkipped();
    return {
      errors: [],
      ok: true,
      requiredFilesOk: true,
      verifyResult: null,
    };
  }

  const errors: string[] = [];
  const missingFiles = requiredTreeFiles(contextTreePath).filter((file) => !existsSync(file));
  for (const missing of missingFiles) {
    errors.push(`missing required file: ${missing}`);
  }

  const verifyResult = runFixtureVerify({ caseId, contextTreePath, paths, reporter, verbose });
  if (verifyResult.exitCode !== 0) {
    errors.push(
      `tree verify failed with exit ${verifyResult.exitCode}: ${previewText(verifyResult.stderr || verifyResult.stdout)}`,
    );
  }

  return {
    errors,
    ok: errors.length === 0,
    requiredFilesOk: missingFiles.length === 0,
    verifyResult,
  };
}
