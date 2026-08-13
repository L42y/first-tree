import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunPaths } from "../../../core/types.js";
import { FIRST_TREE_WRITE_GATE_CASES } from "../cases.js";
import { snapshotTreeArtifactBaseline } from "../fixture.js";
import { casePassed, deriveMetrics } from "../grader.js";
import { buildGrading } from "../summary.js";
import type { EvalMetrics, FirstTreeWriteEvalCase } from "../types.js";

const GOOD_THREE_BULLET_SUMMARY = `- The note separates deterministic gate checks from the optional quality judge.
- Deterministic gates cover hard risks such as missing sources, forbidden tree side effects, and verify failures.
- The quality judge runs only for an explicit quality command, keeping default gates deterministic.`;

function findCase(id: string): FirstTreeWriteEvalCase {
  const evalCase = FIRST_TREE_WRITE_GATE_CASES.find((candidate) => candidate.id === id);
  if (!evalCase) throw new Error(`Missing test case ${id}`);
  return evalCase;
}

function unboundEventMetrics(evalCase: FirstTreeWriteEvalCase, text: string): EvalMetrics {
  return eventMetrics(evalCase, [{ event: { text, type: "agent_message" }, type: "codex_event" }]);
}

function tempPaths(tempRoot: string): RunPaths {
  return {
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
}

function eventMetrics(evalCase: FirstTreeWriteEvalCase, events: readonly unknown[]): EvalMetrics {
  const tempRoot = mkdtempSync(join(tmpdir(), "write-eval-unbound-event-"));
  try {
    return deriveMetrics(
      events,
      evalCase,
      { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
      0,
      null,
      tempPaths(tempRoot),
      null,
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
    ordinarySummaryShapeObserved: false,
    postModelVerifyResult: null,
    postModelVerifySucceeded: null,
    runnerExitCode: 0,
    skillFileReadObserved: true,
    chatAskCount: 0,
    sourceAskObserved: false,
    sourceRepoChanged: false,
    staleTreeArtifactAccessObserved: false,
    staleTreeArtifactModifiedObserved: false,
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
    unresolvedBindingMentionObserved: false,
    unresolvedGapStatementObserved: false,
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
      finalResponse: GOOD_THREE_BULLET_SUMMARY,
      ordinarySummaryShapeObserved: true,
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
      finalResponse: GOOD_THREE_BULLET_SUMMARY,
      ordinarySummaryShapeObserved: true,
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
          finalResponse: GOOD_THREE_BULLET_SUMMARY,
          firstTreeArgv: [["tree", "tree", "--help"]],
          ordinarySummaryShapeObserved: true,
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
      ordinarySummaryShapeObserved: true,
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

  it("fails the no-source explicit unbound write when the reply asks for a source artifact", () => {
    const evalCase = findCase("unbound-no-source-explicit-write-reports-gap");
    const metrics = eventMetrics(evalCase, [
      {
        event: {
          text: "This Tree write cannot be completed because no Tree is bound. Please provide a source artifact to continue.",
          type: "agent_message",
        },
        type: "codex_event",
      },
    ]);

    expect(metrics.unboundGapStatementObserved).toBe(true);
    expect(metrics.sourceAskObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("fails when an earlier delivery asks for a source even though the final text is gap-only", () => {
    const evalCase = findCase("unbound-no-source-explicit-write-reports-gap");
    const metrics = eventMetrics(evalCase, [
      {
        argv: ["chat", "ask", "user", "-F", "ask.md"],
        body: "Please share a source artifact so I can update the tree.",
        phase: "model",
        type: "first_tree_call",
      },
      {
        event: { text: "This Tree write cannot be completed because no Tree is bound.", type: "agent_message" },
        type: "codex_event",
      },
    ]);

    expect(metrics.unboundGapStatementObserved).toBe(true);
    expect(metrics.sourceAskObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("fails on an inline chat ask whose body the shim leaves empty", () => {
    const evalCase = findCase("unbound-no-source-explicit-write-reports-gap");
    const metrics = eventMetrics(evalCase, [
      {
        argv: ["chat", "ask", "user", "Please share a source artifact"],
        phase: "model",
        type: "first_tree_call",
      },
      {
        event: { text: "This Tree write cannot be completed because no Tree is bound.", type: "agent_message" },
        type: "codex_event",
      },
    ]);

    expect(metrics.chatAskCount).toBe(1);
    expect(metrics.unboundGapStatementObserved).toBe(true);
    expect(metrics.sourceAskObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("fails on synonymous input requests without the literal word source", () => {
    for (const [caseId, gap] of [
      ["unbound-no-source-explicit-write-reports-gap", "This Tree write cannot be completed because no Tree is bound."],
      [
        "unresolved-no-source-explicit-write-reports-gap",
        "This Tree write cannot be completed right now because the binding could not be confirmed.",
      ],
    ] as const) {
      for (const phrasing of [
        "Please paste the architecture decision.",
        "Could you attach the design note?",
        "Send me the PR that records the decision.",
      ]) {
        const evalCase = findCase(caseId);
        const metrics = eventMetrics(evalCase, [
          {
            event: { text: `${gap} ${phrasing}`, type: "agent_message" },
            type: "codex_event",
          },
        ]);

        expect(metrics.sourceAskObserved, `input request not detected: ${phrasing}`).toBe(true);
        expect(casePassed(evalCase, metrics)).toBe(false);
      }
    }
  });

  it("fails a no-source explicit case on ANY chat ask, even a content-free one", () => {
    const evalCase = findCase("unresolved-no-source-explicit-write-reports-gap");
    const metrics = eventMetrics(evalCase, [
      {
        argv: ["chat", "ask", "user", "Ready when you are."],
        phase: "model",
        type: "first_tree_call",
      },
      {
        event: {
          text: "This Tree write cannot be completed right now because the binding could not be confirmed.",
          type: "agent_message",
        },
        type: "codex_event",
      },
    ]);

    expect(metrics.chatAskCount).toBe(1);
    expect(metrics.sourceAskObserved).toBe(false);
    expect(metrics.unresolvedGapStatementObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("passes the no-source explicit unbound write with a gap-only reply", () => {
    const evalCase = findCase("unbound-no-source-explicit-write-reports-gap");
    const metrics = eventMetrics(evalCase, [
      {
        event: { text: "This Tree write cannot be completed because no Tree is bound.", type: "agent_message" },
        type: "codex_event",
      },
    ]);

    expect(metrics.unboundGapStatementObserved).toBe(true);
    expect(metrics.sourceAskObserved).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("fails the no-source explicit unresolved write when the reply asks for a source artifact", () => {
    const evalCase = findCase("unresolved-no-source-explicit-write-reports-gap");
    const gapOnly = eventMetrics(evalCase, [
      {
        event: {
          text: "This Tree write cannot be completed right now because the binding could not be confirmed.",
          type: "agent_message",
        },
        type: "codex_event",
      },
    ]);
    expect(gapOnly.unresolvedGapStatementObserved).toBe(true);
    expect(gapOnly.sourceAskObserved).toBe(false);
    expect(casePassed(evalCase, gapOnly)).toBe(true);

    const withAsk = eventMetrics(evalCase, [
      {
        event: {
          text: "This Tree write cannot be completed right now because the binding could not be confirmed. Share a source artifact and I will retry.",
          type: "agent_message",
        },
        type: "codex_event",
      },
    ]);
    expect(withAsk.sourceAskObserved).toBe(true);
    expect(casePassed(evalCase, withAsk)).toBe(false);
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
      `${GOOD_THREE_BULLET_SUMMARY}\nUse the web console to export the report.`,
      `${GOOD_THREE_BULLET_SUMMARY}\nAsk your admin for billing access.`,
    ]) {
      const metrics = unboundEventMetrics(evalCase, text);
      expect(metrics.ordinarySummaryShapeObserved).toBe(true);
      expect(metrics.treeSetupSurfaceGuidanceObserved).toBe(false);
      expect(metrics.unboundAbsenceMentionObserved).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(true);
    }
  });

  it("passes the unbound ordinary task with business prose mentioning an admin or settings", () => {
    const evalCase = findCase("unbound-tree-skips-write");
    const metrics = unboundEventMetrics(
      evalCase,
      `${GOOD_THREE_BULLET_SUMMARY}\nAn admin can tweak notification settings later.`,
    );

    expect(metrics.ordinarySummaryShapeObserved).toBe(true);
    expect(metrics.treeSetupSurfaceGuidanceObserved).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("detects Tree CLI invocations and setup guidance from unbound run events", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "write-eval-unbound-metrics-"));
    try {
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
        tempPaths(tempRoot),
        null,
        snapshotTreeArtifactBaseline(tempRoot),
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
      const evalCase = findCase("unbound-tree-explicit-write-reports-gap");
      const baseline = snapshotTreeArtifactBaseline(tempRoot);
      const blank = deriveMetrics(
        [],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        tempPaths(tempRoot),
        null,
        baseline,
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
        tempPaths(tempRoot),
        null,
        baseline,
      );
      expect(withManifest.unboundTreeArtifactsCreated).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("treats a retired stale checkout as a legal baseline but flags run modifications", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "write-eval-stale-checkout-baseline-"));
    try {
      const evalCase = findCase("unbound-stale-checkout-explicit-write-reports-gap");
      // Explicit unbind residue: no manifest, but a clean Tree checkout left
      // by the previous binding.
      mkdirSync(join(tempRoot, "context-tree", "system"), { recursive: true });
      writeFileSync(join(tempRoot, "context-tree", "NODE.md"), "# Stale Tree\n", "utf8");
      writeFileSync(join(tempRoot, "context-tree", "system", "NODE.md"), "# System\n", "utf8");
      const baseline = snapshotTreeArtifactBaseline(tempRoot);

      // The untouched residue must NOT trip the guard.
      const untouched = deriveMetrics(
        [],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        tempPaths(tempRoot),
        null,
        baseline,
      );
      expect(untouched.unboundTreeArtifactsCreated).toBe(false);

      // Modifying the stale checkout DOES trip it.
      writeFileSync(join(tempRoot, "context-tree", "NODE.md"), "# Rewritten by the model\n", "utf8");
      const modified = deriveMetrics(
        [],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        tempPaths(tempRoot),
        null,
        baseline,
      );
      expect(modified.unboundTreeArtifactsCreated).toBe(true);

      // So does deleting it, and so does a newly created manifest.
      rmSync(join(tempRoot, "context-tree"), { force: true, recursive: true });
      mkdirSync(join(tempRoot, ".first-tree"), { recursive: true });
      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), "{}\n", "utf8");
      const deletedAndManifest = deriveMetrics(
        [],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        tempPaths(tempRoot),
        null,
        baseline,
      );
      expect(deletedAndManifest.unboundTreeArtifactsCreated).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("requires the unresolved stale manifest and checkout to stay byte-identical", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "write-eval-unresolved-baseline-"));
    try {
      const evalCase = findCase("unresolved-tree-skips-write");
      mkdirSync(join(tempRoot, ".first-tree"), { recursive: true });
      mkdirSync(join(tempRoot, "context-tree"), { recursive: true });
      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), '{"tree":"context-tree"}\n', "utf8");
      writeFileSync(join(tempRoot, "context-tree", "NODE.md"), "# Stale Tree\n", "utf8");
      const baseline = snapshotTreeArtifactBaseline(tempRoot);

      const untouched = deriveMetrics(
        [],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        tempPaths(tempRoot),
        join(tempRoot, "context-tree"),
        baseline,
      );
      expect(untouched.staleTreeArtifactModifiedObserved).toBe(false);
      expect(untouched.unboundTreeArtifactsCreated).toBe(false);

      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), '{"tree":"elsewhere"}\n', "utf8");
      const modified = deriveMetrics(
        [],
        evalCase,
        { errors: [], ok: true, requiredFilesOk: true, verifyResult: null },
        0,
        null,
        tempPaths(tempRoot),
        join(tempRoot, "context-tree"),
        baseline,
      );
      expect(modified.staleTreeArtifactModifiedObserved).toBe(true);
      expect(casePassed(evalCase, modified)).toBe(false);

      const grading = buildGrading(evalCase, modified, false);
      expect(grading.scores.risk_pass).toBe(false);
      expect(grading.riskFlags.map((flag) => flag.label)).toContain("stale_tree_artifact_modified");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not read the specific missing-binding statement as setup guidance", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "write-eval-unbound-gap-metrics-"));
    try {
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
        tempPaths(tempRoot),
        null,
        snapshotTreeArtifactBaseline(tempRoot),
      );

      expect(metrics.treeCliInvocationCount).toBe(0);
      expect(metrics.treeSetupGuidanceObserved).toBe(false);
      expect(metrics.expectedResponseObserved).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes the unresolved ordinary source task when the tree write is silently skipped", () => {
    const evalCase = findCase("unresolved-tree-skips-write");
    const metrics = baseMetrics({
      finalResponse: GOOD_THREE_BULLET_SUMMARY,
      ordinarySummaryShapeObserved: true,
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

  it("fails the unresolved ordinary source task when the model reads the skill file", () => {
    const evalCase = findCase("unresolved-tree-skips-write");
    const metrics = baseMetrics({
      finalResponse: GOOD_THREE_BULLET_SUMMARY,
      ordinarySummaryShapeObserved: true,
      skillFileReadObserved: true,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, false);
    expect(grading.scores.routing_pass).toBe(false);
  });

  it("fails the unresolved ordinary source task when the model reads the stale manifest or checkout", () => {
    const evalCase = findCase("unresolved-tree-skips-write");
    const metrics = baseMetrics({
      finalResponse: GOOD_THREE_BULLET_SUMMARY,
      ordinarySummaryShapeObserved: true,
      skillFileReadObserved: false,
      staleTreeArtifactAccessObserved: true,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, false);
    expect(grading.scores.routing_pass).toBe(false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("stale_tree_artifact_access");
  });

  it("detects stale manifest and checkout reads from unresolved run events", () => {
    const evalCase = findCase("unresolved-tree-skips-write");
    for (const command of ["cat .first-tree/workspace.json", "sed -n 1,40p context-tree/NODE.md"]) {
      const metrics = eventMetrics(evalCase, [
        { event: { command, type: "tool_call" }, type: "codex_event" },
        {
          event: {
            text: GOOD_THREE_BULLET_SUMMARY,
            type: "agent_message",
          },
          type: "codex_event",
        },
      ]);

      expect(metrics.staleTreeArtifactAccessObserved, `stale access not detected: ${command}`).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(false);
    }
  });

  it("detects bare-path, descendant, and cwd-based stale checkout reads", () => {
    const evalCase = findCase("unresolved-tree-skips-write");
    for (const event of [
      { command: "cd context-tree && cat NODE.md", type: "tool_call" },
      { command: "git -C context-tree status", type: "tool_call" },
      { command: "ls context-tree", type: "tool_call" },
      { command: "ls context-tree/system", type: "tool_call" },
      { command: "cat NODE.md", type: "tool_call", workdir: "/tmp/workspace/context-tree" },
    ]) {
      const metrics = eventMetrics(evalCase, [
        { event, type: "codex_event" },
        {
          event: {
            text: GOOD_THREE_BULLET_SUMMARY,
            type: "agent_message",
          },
          type: "codex_event",
        },
      ]);

      expect(metrics.staleTreeArtifactAccessObserved, `stale access not detected: ${JSON.stringify(event)}`).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(false);
    }
  });

  it("does not flag prose that stays off the stale artifact paths in an unresolved task", () => {
    const evalCase = findCase("unresolved-tree-skips-write");
    const metrics = eventMetrics(evalCase, [
      {
        event: {
          text: GOOD_THREE_BULLET_SUMMARY,
          type: "agent_message",
        },
        type: "codex_event",
      },
    ]);

    expect(metrics.staleTreeArtifactAccessObserved).toBe(false);
    expect(metrics.ordinarySummaryShapeObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("does not flag query-string usages of the checkout name as path access", () => {
    const evalCase = findCase("unresolved-tree-skips-write");
    for (const command of ["rg -n 'context-tree' README.md", "git log --grep=context-tree"]) {
      const metrics = eventMetrics(evalCase, [
        { event: { command, type: "tool_call" }, type: "codex_event" },
        {
          event: {
            text: GOOD_THREE_BULLET_SUMMARY,
            type: "agent_message",
          },
          type: "codex_event",
        },
      ]);

      expect(metrics.staleTreeArtifactAccessObserved, `query token flagged: ${command}`).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(true);
    }
  });

  it("does not flag bare positional or name-query tokens as path access", () => {
    const evalCase = findCase("unresolved-tree-skips-write");
    for (const command of ["rg context-tree README.md", "find . -name context-tree"]) {
      const metrics = eventMetrics(evalCase, [
        { event: { command, type: "tool_call" }, type: "codex_event" },
        {
          event: {
            text: GOOD_THREE_BULLET_SUMMARY,
            type: "agent_message",
          },
          type: "codex_event",
        },
      ]);

      expect(metrics.staleTreeArtifactAccessObserved, `query token flagged: ${command}`).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(true);
    }
  });

  it("detects a Windows-style cwd pointing at the stale checkout", () => {
    const evalCase = findCase("unresolved-tree-skips-write");
    const metrics = eventMetrics(evalCase, [
      { event: { command: "type NODE.md", type: "tool_call", workdir: "C:\\tmp\\context-tree" }, type: "codex_event" },
      {
        event: {
          text: GOOD_THREE_BULLET_SUMMARY,
          type: "agent_message",
        },
        type: "codex_event",
      },
    ]);

    expect(metrics.staleTreeArtifactAccessObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("fails the unresolved ordinary source task when the reply mentions the binding state", () => {
    const evalCase = findCase("unresolved-tree-skips-write");

    for (const text of [
      "The note separates deterministic gate checks from the quality judge. No Tree is bound in this workspace.",
      "The note separates deterministic gate checks from the quality judge. The binding could not be confirmed.",
    ]) {
      const metrics = unboundEventMetrics(evalCase, text);
      expect(metrics.expectedResponseObserved).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(false);
    }

    const falseClaim = unboundEventMetrics(
      evalCase,
      "The note separates deterministic gate checks from the quality judge. No Tree is bound in this workspace.",
    );
    const grading = buildGrading(evalCase, falseClaim, false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("unresolved_false_unbound_claim");
  });

  it("passes the unresolved explicit write when the model reports only the unconfirmed binding", () => {
    const evalCase = findCase("unresolved-tree-explicit-write-reports-gap");
    const metrics = unboundEventMetrics(
      evalCase,
      "This Tree write cannot be completed right now because the binding could not be confirmed.",
    );

    expect(metrics.unresolvedGapStatementObserved).toBe(true);
    // The unbound gap detector must not be required to match the unresolved gap.
    expect(metrics.unboundGapStatementObserved).toBe(false);
    expect(metrics.treeSetupGuidanceObserved).toBe(false);
    expect(metrics.treeSetupSurfaceGuidanceObserved).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it("fails the unresolved explicit write when the model claims no Tree is bound", () => {
    const evalCase = findCase("unresolved-tree-explicit-write-reports-gap");
    const metrics = unboundEventMetrics(evalCase, "This Tree write cannot be completed because no Tree is bound.");

    expect(metrics.unresolvedGapStatementObserved).toBe(false);
    expect(metrics.unboundAbsenceMentionObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, false);
    expect(grading.scores.outcome_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("unresolved_false_unbound_claim");
  });

  it("fails the unresolved explicit write when the correct gap is followed by a no-bound-Tree claim", () => {
    const evalCase = findCase("unresolved-tree-explicit-write-reports-gap");
    const metrics = unboundEventMetrics(
      evalCase,
      "This Tree write cannot be completed right now because the binding could not be confirmed; no Tree is bound here.",
    );

    expect(metrics.unresolvedGapStatementObserved).toBe(true);
    expect(metrics.unboundAbsenceMentionObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("fails the unresolved explicit write when the reply steers at a setup surface", () => {
    const evalCase = findCase("unresolved-tree-explicit-write-reports-gap");
    const metrics = unboundEventMetrics(
      evalCase,
      "This Tree write cannot be completed right now because the binding could not be confirmed. Go to Settings.",
    );

    expect(metrics.unresolvedGapStatementObserved).toBe(true);
    expect(metrics.unboundSetupSteeringObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("tree_setup_steering");
  });

  it("fails the unresolved explicit write when the model touches the stale artifacts or runs Tree CLI", () => {
    const evalCase = findCase("unresolved-tree-explicit-write-reports-gap");

    const stale = baseMetrics({
      finalResponse: "This Tree write cannot be completed right now because the binding could not be confirmed.",
      staleTreeArtifactAccessObserved: true,
      unresolvedGapStatementObserved: true,
    });
    expect(casePassed(evalCase, stale)).toBe(false);

    const cli = baseMetrics({
      finalResponse: "This Tree write cannot be completed right now because the binding could not be confirmed.",
      firstTreeArgv: [["tree", "tree", "--help"]],
      treeCliInvocationCount: 1,
      unresolvedGapStatementObserved: true,
    });
    expect(casePassed(evalCase, cli)).toBe(false);
  });

  it.each([
    "unbound-tree-skips-write",
    "unresolved-tree-skips-write",
    "unbound-stale-checkout-skips-write",
  ])("passes the ordinary skip task for %s only with the full three-bullet summary shape", (caseId) => {
    const evalCase = findCase(caseId);
    const metrics = unboundEventMetrics(evalCase, GOOD_THREE_BULLET_SUMMARY);

    expect(metrics.ordinarySummaryShapeObserved).toBe(true);
    expect(metrics.expectedResponseObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(true);
  });

  it.each([
    "unbound-tree-skips-write",
    "unresolved-tree-skips-write",
    "unbound-stale-checkout-skips-write",
  ])("fails the ordinary skip task for %s when the response only says deterministic", (caseId) => {
    const evalCase = findCase(caseId);
    const metrics = unboundEventMetrics(evalCase, "Deterministic.");

    // The loose hint OR-logic still matches; the shape oracle must not.
    expect(metrics.expectedResponseObserved).toBe(true);
    expect(metrics.ordinarySummaryShapeObserved).toBe(false);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it.each([
    "unbound-tree-skips-write",
    "unresolved-tree-skips-write",
    "unbound-stale-checkout-skips-write",
  ])("fails the ordinary skip task for %s when it reports the Tree gap first and gives one fact", (caseId) => {
    const evalCase = findCase(caseId);
    const metrics = unboundEventMetrics(
      evalCase,
      "No Tree is bound in this workspace. The note is about deterministic gate checks.",
    );

    expect(metrics.ordinarySummaryShapeObserved).toBe(false);
    expect(metrics.unboundAbsenceMentionObserved).toBe(true);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it.each([
    "unbound-tree-skips-write",
    "unresolved-tree-skips-write",
    "unbound-stale-checkout-skips-write",
  ])("fails the ordinary skip task for %s on a refusal or input ask", (caseId) => {
    const evalCase = findCase(caseId);

    for (const text of [
      "I cannot summarize the note without the Tree.",
      "Please provide the source note so I can summarize it.",
    ]) {
      const metrics = unboundEventMetrics(evalCase, text);
      expect(metrics.ordinarySummaryShapeObserved, `refusal not detected: ${text}`).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(false);
    }
  });

  it("fails unbound branches when the model reads the retired checkout or manifest path", () => {
    const skipCase = findCase("unbound-stale-checkout-skips-write");
    const skip = baseMetrics({
      finalResponse: GOOD_THREE_BULLET_SUMMARY,
      ordinarySummaryShapeObserved: true,
      skillFileReadObserved: false,
      staleTreeArtifactAccessObserved: true,
    });
    expect(casePassed(skipCase, skip)).toBe(false);

    const grading = buildGrading(skipCase, skip, false);
    expect(grading.scores.routing_pass).toBe(false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("stale_tree_artifact_access");

    const explicitCase = findCase("unbound-stale-checkout-explicit-write-reports-gap");
    const explicit = baseMetrics({
      finalResponse: "This Tree write cannot be completed because no Tree is bound.",
      skillFileReadObserved: false,
      staleTreeArtifactAccessObserved: true,
      unboundGapStatementObserved: true,
    });
    expect(casePassed(explicitCase, explicit)).toBe(false);
  });

  it("passes the stale-checkout unbound cases with clean residue behavior", () => {
    const skip = baseMetrics({
      finalResponse: GOOD_THREE_BULLET_SUMMARY,
      ordinarySummaryShapeObserved: true,
      skillFileReadObserved: false,
    });
    expect(casePassed(findCase("unbound-stale-checkout-skips-write"), skip)).toBe(true);

    const explicit = baseMetrics({
      finalResponse: "This Tree write cannot be completed because no Tree is bound.",
      skillFileReadObserved: false,
      unboundGapStatementObserved: true,
    });
    expect(casePassed(findCase("unbound-stale-checkout-explicit-write-reports-gap"), explicit)).toBe(true);
  });

  it("fails unresolved branches when the run modifies the stale manifest or checkout", () => {
    const skip = baseMetrics({
      finalResponse: GOOD_THREE_BULLET_SUMMARY,
      ordinarySummaryShapeObserved: true,
      skillFileReadObserved: false,
      staleTreeArtifactModifiedObserved: true,
    });
    expect(casePassed(findCase("unresolved-tree-skips-write"), skip)).toBe(false);

    const explicit = baseMetrics({
      finalResponse: "This Tree write cannot be completed right now because the binding could not be confirmed.",
      staleTreeArtifactModifiedObserved: true,
      unresolvedGapStatementObserved: true,
    });
    const explicitCase = findCase("unresolved-tree-explicit-write-reports-gap");
    expect(casePassed(explicitCase, explicit)).toBe(false);

    const grading = buildGrading(explicitCase, explicit, false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("stale_tree_artifact_modified");
  });
});
