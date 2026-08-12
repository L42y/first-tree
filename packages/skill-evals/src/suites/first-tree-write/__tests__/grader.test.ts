import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function unboundEventMetrics(evalCase: FirstTreeWriteEvalCase, text: string): EvalMetrics {
  const tempRoot = mkdtempSync(join(tmpdir(), "write-eval-unbound-event-"));
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
    return deriveMetrics(
      [{ event: { text, type: "agent_message" }, type: "codex_event" }],
      evalCase,
      { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
      0,
      null,
      paths,
      null,
    );
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
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
    treeSetupSurfaceGuidanceObserved: false,
    treeStatus: "",
    unboundAbsenceMentionObserved: false,
    unboundGapStatementObserved: false,
    unboundSetupSteeringObserved: false,
    unboundTreeArtifactsCreated: false,
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

  it("fails the unbound ordinary source task when the model reads the skill file", () => {
    const evalCase = findCase("unbound-tree-skips-write");
    const metrics = baseMetrics({
      finalResponse: "The note separates deterministic gate checks from the quality judge.",
      skillFileReadObserved: true,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, false);
    expect(grading.scores.routing_pass).toBe(false);
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
          unboundGapStatementObserved: true,
        }),
      ),
    ).toBe(true);
  });

  it("passes the unbound explicit write even when the model reads the skill file", () => {
    expect(
      casePassed(
        findCase("unbound-tree-explicit-write-reports-gap"),
        baseMetrics({
          finalResponse: "This Tree write cannot be completed because no Tree is bound.",
          skillFileReadObserved: true,
          unboundGapStatementObserved: true,
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
          unboundGapStatementObserved: true,
          treeSetupGuidanceObserved: true,
        }),
      ),
    ).toBe(false);
  });

  it("fails the unbound explicit write when the reason is missing or not Tree-anchored", () => {
    const evalCase = findCase("unbound-tree-explicit-write-reports-gap");

    // The loose response-hint OR-logic accepts both of these; the anchored gap
    // metric must not.
    const noReason = baseMetrics({ finalResponse: "This write cannot be completed right now." });
    expect(noReason.expectedResponseObserved).toBe(true);
    expect(noReason.unboundGapStatementObserved).toBe(false);
    expect(casePassed(evalCase, noReason)).toBe(false);

    const wrongReason = baseMetrics({
      finalResponse: "This Tree write cannot be completed because the source repository is not bound.",
    });
    expect(wrongReason.unboundGapStatementObserved).toBe(false);
    expect(casePassed(evalCase, wrongReason)).toBe(false);
  });

  it("fails the unbound explicit write when the reply steers at a setup surface", () => {
    const evalCase = findCase("unbound-tree-explicit-write-reports-gap");

    for (const steering of [
      "This Tree write cannot be completed because no Tree is bound. Go to Settings → Context Tree.",
      "This Tree write cannot be completed because no Tree is bound. Use the web console to bind one.",
      "This Tree write cannot be completed because no Tree is bound. Ask an operator to bind it.",
      "This Tree write cannot be completed because no Tree is bound. Configure the Tree first.",
      "This Tree write cannot be completed because no Tree is bound. Go to Settings.",
    ]) {
      const metrics = unboundEventMetrics(evalCase, steering);
      expect(
        metrics.treeSetupSurfaceGuidanceObserved || metrics.unboundSetupSteeringObserved,
        `steering not detected: ${steering}`,
      ).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(false);
    }

    const surface = baseMetrics({
      finalResponse: "This Tree write cannot be completed because no Tree is bound. Go to Settings → Context Tree.",
      treeSetupSurfaceGuidanceObserved: true,
      unboundGapStatementObserved: true,
    });
    const grading = buildGrading(evalCase, surface, false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("tree_setup_surface_guidance");
  });

  it("fails the unbound ordinary source task when the reply proactively mentions the missing binding", () => {
    const evalCase = findCase("unbound-tree-skips-write");
    const metrics = unboundEventMetrics(
      evalCase,
      "The note separates deterministic gate checks from the quality judge. No Tree is bound in this workspace.",
    );

    expect(metrics.expectedResponseObserved).toBe(true);
    expect(metrics.treeSetupGuidanceObserved).toBe(false);
    expect(metrics.treeSetupSurfaceGuidanceObserved).toBe(false);
    expect(metrics.unboundAbsenceMentionObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, false);
    expect(grading.scores.outcome_pass).toBe(false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("unbound_absence_mention");
  });

  it("passes the unbound ordinary task with business prose mentioning the web console or an admin", () => {
    const evalCase = findCase("unbound-tree-skips-write");

    for (const text of [
      "The note separates deterministic gate checks from the quality judge. Use the web console to export the report.",
      "The note separates deterministic gate checks from the quality judge. Ask your admin for billing access.",
    ]) {
      const metrics = unboundEventMetrics(evalCase, text);
      expect(metrics.treeSetupSurfaceGuidanceObserved).toBe(false);
      expect(metrics.unboundAbsenceMentionObserved).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(true);
    }
  });

  it("passes the unbound ordinary task with business prose mentioning an admin or settings", () => {
    const evalCase = findCase("unbound-tree-skips-write");
    const metrics = unboundEventMetrics(
      evalCase,
      "The note separates deterministic gate checks from the quality judge; an admin can tweak settings later.",
    );

    expect(metrics.treeSetupSurfaceGuidanceObserved).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
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

  it("fails the unbound ordinary source task when a manifest or Tree checkout appears", () => {
    const evalCase = findCase("unbound-tree-skips-write");
    const metrics = baseMetrics({
      finalResponse: "The note separates deterministic gate checks from the quality judge.",
      skillFileReadObserved: false,
      unboundTreeArtifactsCreated: true,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("unbound_tree_artifacts");
  });

  it("detects a workspace manifest or Context Tree created during an unbound run", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "write-eval-unbound-artifacts-"));
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
      const blank = deriveMetrics(
        [],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        paths,
        null,
      );
      expect(blank.unboundTreeArtifactsCreated).toBe(false);

      mkdirSync(join(tempRoot, ".first-tree"), { recursive: true });
      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), "{}\n", "utf8");
      const withManifest = deriveMetrics(
        [],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        paths,
        null,
      );
      expect(withManifest.unboundTreeArtifactsCreated).toBe(true);
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
