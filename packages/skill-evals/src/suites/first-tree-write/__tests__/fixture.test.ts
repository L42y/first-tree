import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { createFirstTreeShim } from "../../../core/shims/first-tree.js";
import { FIRST_TREE_WRITE_GATE_CASES } from "../cases.js";
import { setupFixture } from "../fixture.js";
import type { FirstTreeWriteEvalCase } from "../types.js";

function currentPackageRoot(): string {
  return basename(process.cwd()) === "skill-evals" ? process.cwd() : join(process.cwd(), "packages", "skill-evals");
}

function findCase(id: string): FirstTreeWriteEvalCase {
  const evalCase = FIRST_TREE_WRITE_GATE_CASES.find((candidate) => candidate.id === id);
  if (!evalCase) throw new Error(`Missing test case ${id}`);
  return evalCase;
}

function runFixture(caseId: string) {
  const paths = createRunPaths({
    caseId,
    packageRoot: currentPackageRoot(),
    startedAt: "2026-06-30T00:00:00.000Z",
  });
  createFirstTreeShim(paths);
  const contextTreePath = setupFixture(findCase(caseId), paths, createEvalReporter(caseId, false));
  return { contextTreePath, paths };
}

describe("first-tree-write fixture shape", { timeout: 20_000 }, () => {
  it("populated cases keep the manifest, declared source repo, and Context Tree", () => {
    const { contextTreePath, paths } = runFixture("durable-source-writes");
    try {
      expect(contextTreePath).not.toBeNull();
      expect(existsSync(join(paths.workspacePath, ".first-tree", "workspace.json"))).toBe(true);
      expect(existsSync(join(paths.workspacePath, "source-repo", "README.md"))).toBe(true);
      expect(existsSync(join(paths.workspacePath, "context-tree", "NODE.md"))).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("unbound cases match the real managed runtime: no manifest, no source repo, no Tree", () => {
    const { contextTreePath, paths } = runFixture("unbound-tree-skips-write");
    try {
      expect(contextTreePath).toBeNull();
      // The real runtime only writes a manifest when a Tree exists; a
      // `tree: null` placeholder must never appear.
      expect(existsSync(join(paths.workspacePath, ".first-tree", "workspace.json"))).toBe(false);
      expect(existsSync(join(paths.workspacePath, "source-repo"))).toBe(false);
      expect(existsSync(join(paths.workspacePath, "context-tree"))).toBe(false);
      // The ordinary task input is still present.
      expect(existsSync(join(paths.workspacePath, "source-artifacts", "durable-decision-note.md"))).toBe(true);
      expect(existsSync(join(paths.workspacePath, "AGENTS.md"))).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
