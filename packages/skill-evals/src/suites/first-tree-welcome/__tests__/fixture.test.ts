import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { createFirstTreeShim } from "../../../core/shims/first-tree.js";
import { FIRST_TREE_WELCOME_GATE_CASES } from "../cases.js";
import { setupFixture, validateFixture } from "../fixture.js";
import type { FirstTreeWelcomeEvalCase } from "../types.js";

function currentPackageRoot(): string {
  return basename(process.cwd()) === "skill-evals" ? process.cwd() : join(process.cwd(), "packages", "skill-evals");
}

function findCase(id: string): FirstTreeWelcomeEvalCase {
  const evalCase = FIRST_TREE_WELCOME_GATE_CASES.find((candidate) => candidate.id === id);
  if (!evalCase) throw new Error(`Missing test case ${id}`);
  return evalCase;
}

function runFixture(caseId: string) {
  const evalCase = findCase(caseId);
  const paths = createRunPaths({
    caseId,
    packageRoot: currentPackageRoot(),
    startedAt: "2026-06-30T00:00:00.000Z",
  });
  createFirstTreeShim(paths);
  const contextTreePath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
  return { contextTreePath, evalCase, paths };
}

describe("first-tree-welcome fixture manifest layout", { timeout: 20_000 }, () => {
  it("writes a flat legacy manifest whose declared source path actually exists", () => {
    const { contextTreePath, evalCase, paths } = runFixture("first-tree-welcome-readable-repo-populated-tree");
    try {
      expect(contextTreePath).not.toBeNull();
      const manifest = JSON.parse(readFileSync(join(paths.workspacePath, ".first-tree", "workspace.json"), "utf8")) as {
        sources: string[];
        sourcesRoot?: string;
        tree: string;
      };
      // The fixture builds <workspace>/source-repo, so the manifest must use
      // the schema's legacy flat form (no sourcesRoot) — a declared binding
      // path that does not exist is a fixture bug.
      expect(manifest.sourcesRoot).toBeUndefined();
      expect(manifest.sources).toEqual(["source-repo"]);
      expect(existsSync(join(paths.workspacePath, "source-repo"))).toBe(true);

      const validation = validateFixture(
        paths,
        contextTreePath,
        evalCase,
        evalCase.id,
        false,
        createEvalReporter(evalCase.id, false),
      );
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("fails fixture validation when the manifest declares a nonexistent source", () => {
    const { contextTreePath, evalCase, paths } = runFixture("first-tree-welcome-readable-repo-populated-tree");
    try {
      writeFileSync(
        join(paths.workspacePath, ".first-tree", "workspace.json"),
        `${JSON.stringify({ tree: "context-tree", sources: ["missing-repo"] }, null, 2)}\n`,
        "utf8",
      );

      const validation = validateFixture(
        paths,
        contextTreePath,
        evalCase,
        evalCase.id,
        false,
        createEvalReporter(evalCase.id, false),
      );
      expect(validation.ok).toBe(false);
      expect(validation.errors.some((error) => error.includes('manifest declares source "missing-repo"'))).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("writes no manifest at all for a no-Tree case", () => {
    const { contextTreePath, paths } = runFixture("first-tree-welcome-no-repo-intro");
    try {
      expect(contextTreePath).toBeNull();
      expect(existsSync(join(paths.workspacePath, ".first-tree", "workspace.json"))).toBe(false);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
