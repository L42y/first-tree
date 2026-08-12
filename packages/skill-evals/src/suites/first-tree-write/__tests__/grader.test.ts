import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunPaths } from "../../../core/types.js";
import { FIRST_TREE_WRITE_GATE_CASES } from "../cases.js";
import { casePassed, deriveMetrics } from "../grader.js";
import { buildGrading } from "../summary.js";
import type { EvalMetrics, FirstTreeWriteEvalCase } from "../types.js";

function findCase(id: string): FirstTreeWriteEvalCase {
  const evalCase = FIRST_TREE_WRITE_GATE_CASES.find((candidate) => candidate.id === id);
  if (!evalCase) throw new Error(`Missing test case ${id}`);
  return evalCase;
}

function baseMetrics(overrides: Partial<EvalMetrics>): EvalMetrics {
  return {
    expectedDiffSnippetsObserved: true,
    expectedResponseObserved: true,
    finalResponse: "Done.",
    firstTreeArgv: [],
    firstTreeCommandResults: [],
    fixtureValidationOk: true,
    forbiddenContentHits: [],
    modelVerifySucceeded: false,
    postModelVerifyResult: null,
    postModelVerifySucceeded: null,
    runnerExitCode: 0,
    skillFileReadObserved: true,
    sourceRepoChanged: false,
    treeChanged: false,
    treeCliInvocationCount: 0,
    treeDiff: "",
    treeSetupGuidanceObserved: false,
    treeStatus: "",
    verifySucceeded: false,
    ...overrides,
  };
}

describe("first-tree-write grader", () => {
  it("passes no-source when the model reads the skill, refuses, and leaves the tree unchanged", () => {
    expect(
      casePassed(findCase("no-source-refuses"), baseMetrics({ finalResponse: "Please provide a source artifact." })),
    ).toBe(true);
  });

  it("fails no-source when the tree changed", () => {
    const evalCase = findCase("no-source-refuses");
    const metrics = baseMetrics({
      treeChanged: true,
      treeDiff: "+Unexpected write\n",
      treeStatus: " M system/context-management/skill-eval-framework.md\n",
    });

    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, casePassed(evalCase, metrics));
    expect(grading.scores).toEqual({
      outcome_pass: false,
      process_pass: true,
      risk_pass: false,
      routing_pass: true,
    });
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("unexpected_tree_write");
  });

  it("passes durable source when the tree changes and verify succeeds", () => {
    expect(
      casePassed(
        findCase("durable-source-writes"),
        baseMetrics({
          finalResponse: "Updated the tree and verify passed.",
          treeChanged: true,
          treeDiff: "+Deterministic gates are separate from quality judges.\n",
          treeStatus: " M system/context-management/skill-eval-framework.md\n",
          modelVerifySucceeded: true,
          postModelVerifyResult: {
            args: ["tree", "verify", "--tree-path", "/tmp/context-tree"],
            command: "first-tree",
            cwd: "/tmp/workspace",
            exitCode: 0,
            stderr: "",
            stdout: "All checks passed.\n",
          },
          postModelVerifySucceeded: true,
          verifySucceeded: true,
        }),
      ),
    ).toBe(true);
  });

  it("fails durable source when the model verify command succeeds but post-model verify fails", () => {
    expect(
      casePassed(
        findCase("durable-source-writes"),
        baseMetrics({
          finalResponse: "Updated the tree and verify passed.",
          treeChanged: true,
          treeDiff: "+Deterministic gates are separate from quality judges.\n",
          treeStatus: " M system/context-management/skill-eval-framework.md\n",
          modelVerifySucceeded: true,
          postModelVerifyResult: {
            args: ["tree", "verify", "--tree-path", "/tmp/context-tree"],
            command: "first-tree",
            cwd: "/tmp/workspace",
            exitCode: 1,
            stderr: "",
            stdout: "Some checks failed.\n",
          },
          postModelVerifySucceeded: false,
          verifySucceeded: false,
        }),
      ),
    ).toBe(false);
  });

  it("passes the unbound ordinary source task when the tree write is silently skipped", () => {
    const evalCase = findCase("unbound-tree-skips-write");
    const metrics = baseMetrics({
      finalResponse: "The note separates deterministic gate checks from the quality judge.",
      skillFileReadObserved: false,
    });

    expect(casePassed(evalCase, metrics)).toBe(true);

    const grading = buildGrading(evalCase, metrics, true);
    expect(grading.scores).toEqual({
      outcome_pass: true,
      process_pass: true,
      risk_pass: true,
      routing_pass: true,
    });
  });

  it("fails the unbound ordinary source task when a Tree CLI command runs", () => {
    expect(
      casePassed(
        findCase("unbound-tree-skips-write"),
        baseMetrics({
          finalResponse: "The note separates deterministic gate checks from the quality judge.",
          firstTreeArgv: [["tree", "tree", "--help"]],
          skillFileReadObserved: false,
          treeCliInvocationCount: 1,
        }),
      ),
    ).toBe(false);
  });

  it("fails the unbound ordinary source task when the response pushes tree setup", () => {
    const evalCase = findCase("unbound-tree-skips-write");
    const metrics = baseMetrics({
      finalResponse: "You should bind a Context Tree first.",
      skillFileReadObserved: false,
      treeSetupGuidanceObserved: true,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("tree_setup_guidance");
  });

  it("passes the unbound explicit write when the model reports only the missing binding", () => {
    expect(
      casePassed(
        findCase("unbound-tree-explicit-write-reports-gap"),
        baseMetrics({
          finalResponse: "This Tree write cannot be completed because no Tree is bound.",
        }),
      ),
    ).toBe(true);
  });

  it("fails the unbound explicit write when the model expands the gap into bind guidance", () => {
    expect(
      casePassed(
        findCase("unbound-tree-explicit-write-reports-gap"),
        baseMetrics({
          finalResponse: "This Tree write cannot be completed because no Tree is bound.",
          treeSetupGuidanceObserved: true,
        }),
      ),
    ).toBe(false);
  });

  it("detects Tree CLI invocations and setup guidance from unbound run events", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "write-eval-unbound-metrics-"));
    try {
      const paths: RunPaths = {
        binDir: join(tempRoot, "bin"),
        eventsPath: join(tempRoot, "events.jsonl"),
        gradingJsonPath: join(tempRoot, "grading.json"),
        modelEventsPath: join(tempRoot, ".first-tree-eval", "events.jsonl"),
        packageRoot: tempRoot,
        repoRoot: tempRoot,
        runRoot: tempRoot,
        shellEnvDir: join(tempRoot, "shell-env"),
        summaryJsonPath: join(tempRoot, "summary.json"),
        summaryMdPath: join(tempRoot, "summary.md"),
        workspacePath: tempRoot,
      };
      const evalCase = findCase("unbound-tree-explicit-write-reports-gap");
      const metrics = deriveMetrics(
        [
          { argv: ["tree", "bind", "context-tree"], phase: "model", type: "first_tree_call" },
          {
            event: { text: "You can bind a Context Tree to enable this write.", type: "agent_message" },
            type: "codex_event",
          },
        ],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        paths,
        null,
      );

      expect(metrics.treeCliInvocationCount).toBe(1);
      expect(metrics.treeSetupGuidanceObserved).toBe(true);
      expect(metrics.treeChanged).toBe(false);
      expect(metrics.forbiddenContentHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not read the specific missing-binding statement as setup guidance", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "write-eval-unbound-gap-metrics-"));
    try {
      const paths: RunPaths = {
        binDir: join(tempRoot, "bin"),
        eventsPath: join(tempRoot, "events.jsonl"),
        gradingJsonPath: join(tempRoot, "grading.json"),
        modelEventsPath: join(tempRoot, ".first-tree-eval", "events.jsonl"),
        packageRoot: tempRoot,
        repoRoot: tempRoot,
        runRoot: tempRoot,
        shellEnvDir: join(tempRoot, "shell-env"),
        summaryJsonPath: join(tempRoot, "summary.json"),
        summaryMdPath: join(tempRoot, "summary.md"),
        workspacePath: tempRoot,
      };
      const evalCase = findCase("unbound-tree-explicit-write-reports-gap");
      const metrics = deriveMetrics(
        [
          {
            event: { text: "This Tree write cannot be completed because no Tree is bound.", type: "agent_message" },
            type: "codex_event",
          },
        ],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        paths,
        null,
      );

      expect(metrics.treeCliInvocationCount).toBe(0);
      expect(metrics.treeSetupGuidanceObserved).toBe(false);
      expect(metrics.expectedResponseObserved).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
