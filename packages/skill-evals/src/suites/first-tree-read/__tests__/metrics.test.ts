import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gradingFailureMessages } from "../../../core/grading.js";
import { snapshotTreeArtifactBaseline } from "../fixture.js";
import { casePassed, deriveMetrics } from "../metrics.js";
import { buildGrading, driftNote } from "../summary.js";
import type {
  EvalMetrics,
  FixtureValidation,
  ImpactNoteExpectation,
  ManagedTransport,
  TreeArtifactBaseline,
} from "../types.js";

const HELP_ARGV = ["tree", "tree", "--help"];
const SELECTOR_ARGV = ["tree", "tree", "/domains/payments"];
const BYO_ROUTE_ARGV = [
  "--json",
  "context",
  "route",
  "--provider",
  "codex",
  "--pathless",
  "--session-candidate",
  "eval-receipt",
];
const BYO_ACTIVATION_ARGV = ["--json", "context", "snapshot", "--candidate", "candidate-byo-read-eval"];
const LEGACY_BYO_ACTIVATION_ARGV = [
  "--json",
  "tree",
  "read",
  "--team",
  "team-byo-read-eval",
  "--snapshot",
  "/tmp/read-task/context-tree",
];
const BYO_SELECTOR_ARGV = ["tree", "tree", "--no-pull", "systems/server/auth"];
const EXACT_COMMIT = "a".repeat(40);
const TEST_SOURCE_AUTHORITY = {
  allowedNodePaths: [
    "NODE.md",
    "domains/payments/NODE.md",
    "product/billing/rollout-policy/NODE.md",
    "product/release/rollout-policy/NODE.md",
    "systems/server/auth/scopes/NODE.md",
  ],
  exactCommit: EXACT_COMMIT,
  repository: "https://github.com/example/context-tree.git",
} as const;
const EXPECTED_FACT = "payments runbook anchor";
const JWT_EXPECTED_FACTS = [
  "User JWT auth is the unified authorization surface.",
  "Route scopes must be checked against live organization membership before cross-org actions.",
  "HTTP routes must follow the repo path conventions document before auth or multi-org changes.",
] as const;

const VALID_FIXTURE: FixtureValidation = {
  domainNodeCount: 2,
  errors: [],
  minDepthOk: true,
  ok: true,
  requiredFilesOk: true,
  verifyResult: null,
};

function skillReadEvent(): unknown {
  return {
    event: {
      command: "sed -n 1,200p skills/first-tree-read/SKILL.md",
      type: "tool_call",
    },
    type: "codex_event",
  };
}

function assistantTextEvent(text: string): unknown {
  return {
    event: {
      content: text,
      type: "assistant_message",
    },
    type: "codex_event",
  };
}

function firstTreeCall(argv: readonly string[], extra: Record<string, unknown> = {}): unknown {
  return {
    argv: [...argv],
    phase: "model",
    type: "first_tree_call",
    ...extra,
  };
}

function firstTreeResult(argv: readonly string[], exitCode: number, extra: Record<string, unknown> = {}): unknown {
  return {
    argv: [...argv],
    exitCode,
    phase: "model",
    type: "first_tree_result",
    ...extra,
  };
}

function managedMessage(
  body: string,
  argv: readonly string[] = ["chat", "send", "gandy2025", "-F", "reply.md"],
): unknown[] {
  return [firstTreeCall(argv, { body }), firstTreeResult(argv, 0)];
}

function managedStatus(body: string): unknown[] {
  const argv = ["chat", "update", "--description", "-"];
  return [firstTreeCall(argv, { body }), firstTreeResult(argv, 0)];
}

function metrics(events: readonly unknown[]): EvalMetrics {
  return deriveMetrics(events, VALID_FIXTURE, 0, [EXPECTED_FACT], { mode: "absent" }, "send");
}

function impactMetrics(
  events: readonly unknown[],
  expectation: ImpactNoteExpectation,
  managedTransport: ManagedTransport = "send",
): EvalMetrics {
  return deriveMetrics(events, VALID_FIXTURE, 0, [EXPECTED_FACT], expectation, managedTransport);
}

describe("first-tree-read metrics pass criteria", () => {
  it("passes trigger cases only when skill read, facts, help, selector, and command results are all OK", () => {
    const nativeOnly = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      ...managedMessage(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.skillFileReadObserved).toBe(true);
    expect(result.expectedFactsObserved).toBe(true);
    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(nativeOnly.managedFinalTransportOk).toBe(false);
    expect(casePassed(true, nativeOnly)).toBe(false);
    expect(result.managedFinalTransportOk).toBe(true);
    expect(casePassed(true, result)).toBe(true);
  });

  it("passes BYO cases only for one ordered SCOPE route and exact detached no-pull snapshot", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(BYO_ROUTE_ARGV),
      firstTreeResult(BYO_ROUTE_ARGV, 0),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(BYO_SELECTOR_ARGV),
      firstTreeResult(BYO_SELECTOR_ARGV, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readRouteCalls).toBe(1);
    expect(result.readRouteSucceeded).toBe(true);
    expect(result.readActivationCalls).toBe(1);
    expect(result.readActivationSucceeded).toBe(true);
    expect(result.byoReadSequenceOk).toBe(true);
    expect(result.byoSelectorsNoPull).toBe(true);
    expect(result.byoSnapshotDetached).toBe(true);
    expect(result.byoSnapshotExactHeadConsistent).toBe(true);
    expect(casePassed(true, result, "byo")).toBe(true);
  });

  it("fails BYO cases when activation is repeated or selectors can refresh", () => {
    const mutableSelector = ["tree", "tree", "systems/server/auth"];
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(BYO_ROUTE_ARGV),
      firstTreeResult(BYO_ROUTE_ARGV, 0),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(mutableSelector),
      firstTreeResult(mutableSelector, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readActivationCalls).toBe(2);
    expect(result.readActivationSucceeded).toBe(false);
    expect(result.byoSelectorsNoPull).toBe(false);
    expect(casePassed(true, result, "byo")).toBe(false);
  });

  it("rejects the legacy tree read activation sequence for BYO cases", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(LEGACY_BYO_ACTIVATION_ARGV),
      firstTreeResult(LEGACY_BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(BYO_SELECTOR_ARGV),
      firstTreeResult(BYO_SELECTOR_ARGV, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readRouteSucceeded).toBe(false);
    expect(result.readActivationSucceeded).toBe(false);
    expect(result.legacyReadActivationCalls).toBe(1);
    expect(result.byoReadSequenceOk).toBe(false);
    expect(casePassed(true, result, "byo")).toBe(false);
  });

  it("rejects a legacy tree read activation even when the current BYO sequence also succeeds", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(LEGACY_BYO_ACTIVATION_ARGV),
      firstTreeResult(LEGACY_BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(BYO_ROUTE_ARGV),
      firstTreeResult(BYO_ROUTE_ARGV, 0),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(BYO_SELECTOR_ARGV),
      firstTreeResult(BYO_SELECTOR_ARGV, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readRouteSucceeded).toBe(true);
    expect(result.readActivationSucceeded).toBe(true);
    expect(result.legacyReadActivationCalls).toBe(1);
    expect(result.byoReadSequenceOk).toBe(false);
    expect(casePassed(true, result, "byo")).toBe(false);
  });

  it("fails trigger cases when facts are present but help is missing", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.expectedFactsObserved).toBe(true);
    expect(result.helpSucceeded).toBe(false);
    expect(result.selectionSucceeded).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(true, result)).toBe(false);
  });

  it("fails trigger cases when help succeeds but no selector succeeds", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(false);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(true, result)).toBe(false);
  });

  it("fails trigger cases when any model-phase first-tree result is non-zero, including later selector failures", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      firstTreeCall(["tree", "tree", "/domains/payments/deep-dive"]),
      firstTreeResult(["tree", "tree", "/domains/payments/deep-dive"], 2),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(false);
    expect(casePassed(true, result)).toBe(false);
  });

  it("recognizes strict expected fact concepts in translated or paraphrased final answers", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        ...managedMessage(`JWT auth routes 要遵守这些约束：
- User JWT 是统一授权面。
- Route scopes 必须结合当前 live organization membership checks。
- HTTP routes 和 multi-org 改动必须遵循 docs/development/http-path-conventions.md。`),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
      { mode: "absent" },
      "send",
    );

    expect(result.expectedFactHits).toEqual([...JWT_EXPECTED_FACTS]);
    expect(result.expectedFactsObserved).toBe(true);
    expect(casePassed(true, result)).toBe(true);
  });

  it("recognizes the user JWT authorization surface when phrased as single authorization surface", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent(`JWT auth routes should:
- Use user JWT auth as the single authorization surface.
- Check route scopes against live organization membership before cross-org actions.
- Follow docs/development/http-path-conventions.md before auth or multi-org route changes.`),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([...JWT_EXPECTED_FACTS]);
    expect(result.expectedFactsObserved).toBe(true);
  });

  it("recognizes the natural unified user JWT authorization surface word order", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent(`JWT auth routes should:
- Use the unified user JWT authorization surface.
- Check route scopes against live organization membership before cross-org actions.
- Follow the repository's HTTP path conventions before auth or multi-org route changes.`),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([...JWT_EXPECTED_FACTS]);
    expect(result.expectedFactsObserved).toBe(true);
  });

  it("does not count isolated terms as expected fact concepts", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent("This only mentions User JWT, route scopes, and path conventions as loose keywords."),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([]);
    expect(result.expectedFactsObserved).toBe(false);
    expect(casePassed(true, result)).toBe(false);
  });

  it("fails bypassed trigger cases when facts appear without a first-tree tree tree selector command", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.expectedFactsObserved).toBe(true);
    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(false);
    expect(casePassed(true, result)).toBe(false);
  });

  it("maps trigger process failures into deterministic grading output", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);
    const grading = buildGrading("read-grading-test", result, true, casePassed(true, result));

    expect(grading.passed).toBe(false);
    expect(grading.scores).toEqual({
      outcome_pass: true,
      process_pass: false,
      risk_pass: true,
      routing_pass: true,
    });
    expect(gradingFailureMessages(grading)[0]).toContain("process_pass=false");
  });

  it("keeps non-trigger cases green when no skill hit, facts, or commands occur", () => {
    const result = metrics([assistantTextEvent("This answer stays outside the Context Tree topic.")]);

    expect(result.skillHit).toBe(false);
    expect(result.expectedFactHits).toEqual([]);
    expect(result.firstTreeCalls).toBe(0);
    expect(result.firstTreeCommandResults).toEqual([]);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(false, result)).toBe(true);
  });

  it("fails non-trigger cases on any model-phase first-tree command usage or non-zero result", () => {
    const usageResult = metrics([firstTreeCall(HELP_ARGV)]);
    const nonZeroResult = metrics([firstTreeResult(["doctor"], 1)]);

    expect(usageResult.skillHit).toBe(true);
    expect(casePassed(false, usageResult)).toBe(false);
    expect(nonZeroResult.skillHit).toBe(true);
    expect(nonZeroResult.modelFirstTreeCommandsOk).toBe(false);
    expect(casePassed(false, nonZeroResult)).toBe(false);
  });

  it("accepts one exact-version English impact note in a managed chat body", () => {
    const body = `JWT routes must enforce the tree constraints.

> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const result = impactMetrics(managedMessage(body), {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    });

    expect(result.impactNoteBehaviorOk).toBe(true);
    expect(result.impactNoteCount).toBe(1);
    expect(result.impactNoteBlankLineBefore).toBe(true);
    expect(result.impactNoteLogicalLinesOk).toBe(true);
    expect(result.impactNoteExactLinksOk).toBe(true);
    expect(result.impactNoteSummaryObjectiveOk).toBe(true);
    expect(result.impactNoteSourceLabels).toEqual(["Organization isolation"]);
    expect(result.impactNoteMetadataFree).toBe(true);
    expect(result.managedFinalTransportOk).toBe(true);
  });

  it("rejects legacy or malformed impact-note scaffolding", () => {
    const body = `JWT routes must enforce the tree constraints.

> **Context Tree impact · Options narrowed**\\
> The organization-isolation rule ruled out a global shared index.\\
> **Source** · [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const result = impactMetrics(managedMessage(body), {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    });

    const absentResult = impactMetrics(managedMessage(body), { mode: "absent" });
    const mixedResult = impactMetrics(
      managedMessage(`JWT routes must enforce the tree constraints.

> **Context Tree impact · Options narrowed**\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`),
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );
    const malformedResults = [
      `> **Context Tree impact · Options narrowed**
> The organization-isolation rule ruled out a global shared index.\\
> **Source** · [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
      `> **Context Tree impact**\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
      `> How Context Tree affected this work
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
      `> How Context Tree affected this work${"  "}
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
      `> **Context Tree impact · Options narrowed**${"  "}
> The organization-isolation rule ruled out a global shared index.\\
> **Source** · [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
    ].map((note) => impactMetrics(managedMessage(`Answer.\n\n${note}`), { mode: "absent" }));

    expect(result.impactNoteCount).toBe(1);
    expect(result.impactNoteBehaviorOk).toBe(false);
    expect(absentResult.impactNoteCount).toBe(1);
    expect(absentResult.impactNoteBehaviorOk).toBe(false);
    expect(mixedResult.impactNoteCount).toBe(1);
    expect(mixedResult.impactNoteBehaviorOk).toBe(false);
    expect(malformedResults.every((item) => item.impactNoteCount === 1)).toBe(true);
    expect(malformedResults.every((item) => item.impactNoteBehaviorOk === false)).toBe(true);
  });

  it("makes material trigger cases fail until the final visible note satisfies the behavior contract", () => {
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const baseEvents = [
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ];
    const note = `Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The payment rule narrowed the implementation boundary.\\
> Context Tree source: [Payments](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/domains/payments/NODE.md)`;
    const withoutNote = impactMetrics(
      [...baseEvents, ...managedMessage(`The tree says ${EXPECTED_FACT}. Final answer without the note.`)],
      expectation,
    );
    const nativeOnly = impactMetrics([...baseEvents, assistantTextEvent(note)], expectation);
    const withNote = impactMetrics(
      [...baseEvents, ...managedMessage(`The tree says ${EXPECTED_FACT}.\n\n${note}`)],
      expectation,
    );

    expect(withoutNote.impactNoteBehaviorOk).toBe(false);
    expect(casePassed(true, withoutNote)).toBe(false);
    expect(nativeOnly.impactNoteBehaviorOk).toBe(true);
    expect(nativeOnly.managedFinalTransportOk).toBe(false);
    expect(casePassed(true, nativeOnly)).toBe(false);
    expect(withNote.impactNoteBehaviorOk).toBe(true);
    expect(withNote.managedFinalTransportOk).toBe(true);
    expect(casePassed(true, withNote)).toBe(true);
  });

  it("rejects duplicate notes, mutable links, and visible receipt metadata", () => {
    const note = `> How Context Tree affected this work\\
> **Options narrowed:** The rule ruled out a shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/main/systems/server/auth/scopes/NODE.md)`;
    const result = impactMetrics(
      [assistantTextEvent(`Answer.\n\n${note}\n\n${note}\n\n{ "contextDecision": { "effect": "constrained" } }`)],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );

    expect(result.impactNoteCount).toBe(2);
    expect(result.impactNoteExactLinksOk).toBe(false);
    expect(result.impactNoteMetadataFree).toBe(false);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it("rejects credential-bearing source links and first-person impact summaries", () => {
    const result = impactMetrics(
      [
        assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** I used Context Tree to rule out a shared index.\\
> Context Tree source: [Organization isolation](https://x-access-token:secret@github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`),
      ],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );

    expect(result.impactNoteExactLinksOk).toBe(false);
    expect(result.impactNoteSummaryObjectiveOk).toBe(false);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it.each([
    "I ruled out the shared index because of the organization-isolation rule.",
    "We ruled out the shared index because of the organization-isolation rule.",
    "Our review ruled out the shared index because of the organization-isolation rule.",
    "The organization-isolation rule led us away from the shared index.",
    "Us reviewers ruled out the shared index because of the organization-isolation rule.",
    "The organization-isolation rule allowed me to choose the local index.",
    "The rule shows I should choose tenant-local storage.",
    "根据我们的评审，组织隔离规则排除了共享索引。",
    "根据我的评审，组织隔离规则排除了共享索引。",
    "The organization-isolation rule ruled out the shared index. Then the approach changed.",
    "The organization-isolation rule ruled out the shared index. another option remains.",
    "The organization-isolation rule ruled out the shared index. **This remains unresolved.**",
  ])("rejects non-objective or multi-sentence impact summaries: %s", (summary) => {
    const result = impactMetrics(
      [
        assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** ${summary}\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`),
      ],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );

    expect(result.impactNoteSummaryObjectiveOk).toBe(false);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it.each([
    "The U.S. isolation rule ruled out the shared index.",
    "The U.S. Organization rule ruled out the shared index.",
    "The I/O isolation rule ruled out shared storage.",
    "The i-012345 storage rule ruled out shared storage.",
    "The ME residency rule ruled out a shared index.",
    "The me-central-1 residency rule ruled out a shared index.",
    "The US residency rule ruled out a shared index.",
    "The us-east-1 residency rule ruled out a shared index.",
    "Phase I narrowed the acceptable rollout scope.",
  ])("does not treat abbreviations or phase labels as first person or sentence boundaries: %s", (summary) => {
    const result = impactMetrics(
      [
        assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** ${summary}\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`),
      ],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );

    expect(result.impactNoteSummaryObjectiveOk).toBe(true);
    expect(result.impactNoteBehaviorOk).toBe(true);
  });

  it("rejects contextDecision metadata in successful chat transport while allowing unrelated metadata", () => {
    const body = `Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const receiptArgv = [
      "chat",
      "send",
      "gandy2025",
      "-F",
      "reply.md",
      "--metadata",
      JSON.stringify({ contextDecision: { effect: "constrained" }, mentionIds: ["member-1"] }),
    ];
    const unrelatedArgv = [
      "chat",
      "send",
      "gandy2025",
      "-F",
      "reply.md",
      "-m",
      JSON.stringify({ mentionIds: ["member-1"] }),
    ];
    const withReceipt = impactMetrics(managedMessage(body, receiptArgv), expectation);
    const withUnrelatedMetadata = impactMetrics(managedMessage(body, unrelatedArgv), expectation);

    expect(withReceipt.impactNoteMetadataFree).toBe(false);
    expect(withReceipt.impactNoteBehaviorOk).toBe(false);
    expect(withUnrelatedMetadata.impactNoteMetadataFree).toBe(true);
    expect(withUnrelatedMetadata.impactNoteBehaviorOk).toBe(true);
  });

  it("rejects exact-looking source links outside the selected repository, commit, or allowed paths", () => {
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: {
        allowedNodePaths: ["systems/server/auth/scopes/NODE.md"],
        exactCommit: EXACT_COMMIT,
        repository: "https://github.com/example/context-tree.git",
      },
      sourceCount: { max: 1, min: 1 },
    };
    const noteFor = (url: string) =>
      assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](${url})`);
    const invalidUrls = [
      `https://evil.example/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md`,
      `https://github.com/another/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md`,
      `https://github.com/example/context-tree/blob/${"b".repeat(40)}/systems/server/auth/scopes/NODE.md`,
      `https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/unknown/NODE.md`,
    ];

    for (const url of invalidUrls) {
      const result = impactMetrics([noteFor(url)], expectation);
      expect(result.impactNoteExactLinksOk).toBe(true);
      expect(result.impactNoteSourceAuthorityOk).toBe(false);
      expect(result.impactNoteBehaviorOk).toBe(false);
    }
  });

  it("requires the note to end the final successful managed message", () => {
    const note = `> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const trailingProse = impactMetrics([assistantTextEvent(`Answer.\n\n${note}\n\nMore detail.`)], expectation);
    const progressOnly = impactMetrics(
      [...managedMessage(`Progress.\n\n${note}`), ...managedMessage("Final answer without the note.")],
      expectation,
    );
    const finalOnly = impactMetrics(
      [...managedMessage("Progress without the note."), ...managedMessage(`Final answer.\n\n${note}`)],
      expectation,
    );
    const modelProgressDuplicate = impactMetrics(
      [assistantTextEvent(`Progress.\n\n${note}`), ...managedMessage(`Final answer.\n\n${note}`)],
      expectation,
    );
    const currentStateDuplicate = impactMetrics(
      [...managedStatus(`Progress.\n\n${note}`), ...managedMessage(`Final answer.\n\n${note}`)],
      expectation,
    );

    expect(trailingProse.impactNoteAtFinalEnd).toBe(false);
    expect(trailingProse.impactNoteBehaviorOk).toBe(false);
    expect(progressOnly.impactNoteAtFinalEnd).toBe(false);
    expect(progressOnly.impactNoteBehaviorOk).toBe(false);
    expect(finalOnly.impactNoteAtFinalEnd).toBe(true);
    expect(finalOnly.impactNoteBehaviorOk).toBe(true);
    expect(modelProgressDuplicate.impactNoteCount).toBe(2);
    expect(modelProgressDuplicate.impactNoteBehaviorOk).toBe(false);
    expect(currentStateDuplicate.impactNoteCount).toBe(2);
    expect(currentStateDuplicate.impactNoteBehaviorOk).toBe(false);
  });

  it("uses the case transport contract rather than deriving transport from the impact effect", () => {
    const body = `需要你决定如何处理冲突。

> Context Tree 如何影响本次工作\\
> **发现约束冲突**：固定发布日期与发布前安全审计无法同时满足，取舍仍待决定。\\
> Context Tree 来源：[Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`;
    const expectation: ImpactNoteExpectation = {
      effect: "conflicted",
      language: "zh",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const sentForBlockingCase = impactMetrics(managedMessage(body), expectation, "ask");
    const askedForBlockingCase = impactMetrics(
      managedMessage(body, ["chat", "ask", "gandy2025", "-F", "question.md"]),
      expectation,
      "ask",
    );
    const sentForTerminalCase = impactMetrics(managedMessage(body), expectation, "send");

    expect(sentForBlockingCase.impactNoteBehaviorOk).toBe(true);
    expect(sentForBlockingCase.managedFinalTransportOk).toBe(false);
    // A blocking question must stay decision-self-sufficient: the note never
    // rides an ask body, even when the ask is the correct final transport.
    expect(askedForBlockingCase.impactNoteBehaviorOk).toBe(false);
    expect(askedForBlockingCase.impactNoteOutsideBlockingAsk).toBe(false);
    expect(askedForBlockingCase.managedFinalTransportOk).toBe(true);
    expect(sentForTerminalCase.impactNoteBehaviorOk).toBe(true);
    expect(sentForTerminalCase.impactNoteOutsideBlockingAsk).toBe(true);
    expect(sentForTerminalCase.managedFinalTransportOk).toBe(true);
  });

  it("rejects the superseded bolded scaffolding on the first or third line", () => {
    const link = `[Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const note = (first: string, third: string) =>
      `Answer.

${first}\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
${third}`;
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const plain = impactMetrics(
      managedMessage(note("> How Context Tree affected this work", `> Context Tree source: ${link}`)),
      expectation,
    );
    const boldFirstLine = impactMetrics(
      managedMessage(note("> **How Context Tree affected this work**", `> Context Tree source: ${link}`)),
      expectation,
    );
    const boldSourceLabel = impactMetrics(
      managedMessage(note("> How Context Tree affected this work", `> **Context Tree source:** ${link}`)),
      expectation,
    );

    // Only the effect label carries emphasis; the fixed scaffolding is plain.
    expect(plain.impactNoteBehaviorOk).toBe(true);
    expect(boldFirstLine.impactNoteBehaviorOk).toBe(false);
    expect(boldSourceLabel.impactNoteBehaviorOk).toBe(false);
  });

  it("reports the transport a case actually requires, not a fixed one", () => {
    const body = `Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The isolation rule ruled out a shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    // An ask-contract case that wrongly finished with `send` must be told that
    // `ask` was required — the previous fixed wording said the opposite.
    const wrongSendForAskCase = impactMetrics(managedMessage(body), expectation, "ask");
    const askNote = driftNote(wrongSendForAskCase, true, "managed") ?? "";
    expect(askNote).toContain("requires chat ask");
    expect(askNote).not.toContain("requires chat send");
    expect(askNote).toContain("final managed delivery was send");

    // A placement-only failure must name the failing predicate, otherwise every
    // displayed shape/authority field reads true with no visible cause.
    const noteInsideAsk = impactMetrics(
      managedMessage(body, ["chat", "ask", "gandy2025", "-F", "question.md"]),
      expectation,
      "ask",
    );
    expect(noteInsideAsk.impactNoteBehaviorOk).toBe(false);
    expect(driftNote(noteInsideAsk, true, "managed") ?? "").toContain("outside blocking ask=false");
  });

  it.each([
    {
      effectLine: "> **发现约束冲突**： 固定发布日期与发布前安全审计无法同时满足，取舍仍待决定。\\",
      sourceLine: `> Context Tree 来源：[Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`,
    },
    {
      effectLine: "> **发现约束冲突**：固定发布日期与发布前安全审计无法同时满足，取舍仍待决定。\\",
      sourceLine: `> Context Tree 来源： [Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`,
    },
  ])("rejects a space after either Chinese scaffolding colon", ({ effectLine, sourceLine }) => {
    const body = `需要你决定如何处理冲突。

> Context Tree 如何影响本次工作\\
${effectLine}
${sourceLine}`;
    const result = impactMetrics(managedMessage(body), {
      effect: "conflicted",
      language: "zh",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    });

    expect(result.impactNoteCount).toBe(1);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it("counts identical impact notes from separate BYO assistant messages", () => {
    const note = `Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const result = impactMetrics([assistantTextEvent(note), assistantTextEvent(note)], {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    });

    expect(result.impactNoteCount).toBe(2);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it("rejects a generic middle sentence and credentials elsewhere in the visible response", () => {
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
      summaryConcepts: [["organization isolation"], ["shared index"], ["ruled out"]],
    };
    const source = `> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const generic = impactMetrics(
      [
        assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** Context Tree narrowed the choice.\\
${source}`),
      ],
      expectation,
    );
    const credentialUrls = [
      "https://x-access-token:secret@github.com/example/private",
      "HTTPS://x-access-token:secret@github.com/example/private",
      "hTtPs://x-access-token:secret@github.com/example/private",
      "ssh://git:secret@github.com/example/private",
    ];
    const credentialResults = credentialUrls.map((url) =>
      impactMetrics(
        [
          assistantTextEvent(`See ${url}.

> How Context Tree affected this work\\
> **Options narrowed:** The organization isolation rule ruled out a global shared index.\\
${source}`),
        ],
        expectation,
      ),
    );
    const legalSshUsername = impactMetrics(
      [
        assistantTextEvent(`The binding clone identity is ssh://git@github.com/example/context-tree.git.

> How Context Tree affected this work\\
> **Options narrowed:** The organization isolation rule ruled out a global shared index.\\
${source}`),
      ],
      expectation,
    );

    expect(generic.impactNoteSummaryConceptsOk).toBe(false);
    expect(generic.impactNoteBehaviorOk).toBe(false);
    for (const result of credentialResults) {
      expect(result.impactNoteVisibleUrlsCredentialFree).toBe(false);
      expect(result.impactNoteBehaviorOk).toBe(false);
    }
    expect(legalSshUsername.impactNoteVisibleUrlsCredentialFree).toBe(true);
    expect(legalSshUsername.impactNoteBehaviorOk).toBe(true);
  });

  it("accepts the complete Chinese conflict template only when the tradeoff remains unresolved", () => {
    const expectation: ImpactNoteExpectation = {
      effect: "conflicted",
      language: "zh",
      mode: "present",
      requiredSourceLabels: ["Rollout Policy"],
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
      summaryConcepts: [["发布日期"], ["安全审计"], ["仍待", "尚未"]],
      summaryForbidden: ["已调整", "已解决"],
    };
    const valid = impactMetrics(
      [
        assistantTextEvent(`不能直接发布。

> Context Tree 如何影响本次工作\\
> **发现约束冲突**：固定发布日期与发布前必须完成安全审计的规则无法同时满足，取舍仍待决定。\\
> Context Tree 来源：[Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`),
      ],
      expectation,
    );
    const fabricatedResolution = impactMetrics(
      [
        assistantTextEvent(`方案如下。

> Context Tree 如何影响本次工作\\
> **发现约束冲突**：发布日期与安全审计发生冲突，方案已调整并已解决。\\
> Context Tree 来源：[Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`),
      ],
      expectation,
    );

    expect(valid.impactNoteBehaviorOk).toBe(true);
    expect(valid.impactNoteLanguage).toBe("zh");
    expect(valid.impactNoteSummaryConceptsOk).toBe(true);
    expect(valid.impactNoteSummaryForbiddenOk).toBe(true);
    expect(fabricatedResolution.impactNoteSummaryForbiddenOk).toBe(false);
    expect(fabricatedResolution.impactNoteBehaviorOk).toBe(false);
  });

  it("requires readable root and disambiguated duplicate labels in a three-source note", () => {
    const result = impactMetrics(
      [
        assistantTextEvent(`The rollout is bounded by all three decisions.

> How Context Tree affected this work\\
> **Options narrowed:** The rollout rules require one reviewable scope, audit approval, and core-release stability.\\
> Context Tree sources: [First Tree Read Eval Context](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/NODE.md) · [Release · Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md) · [Billing · Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/billing/rollout-policy/NODE.md)`),
      ],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        requiredSourceLabels: ["First Tree Read Eval Context", "Release · Rollout Policy", "Billing · Rollout Policy"],
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 3, min: 3 },
      },
    );

    expect(result.impactNoteBehaviorOk).toBe(true);
    expect(result.impactNoteSourceCount).toBe(3);
    expect(result.impactNoteSourceLabels).not.toContain("Node");
  });

  it("keeps navigation-only reads free of impact notes", () => {
    const absent: ImpactNoteExpectation = { mode: "absent" };
    const withoutNote = impactMetrics([assistantTextEvent("systems, domains, operations")], absent);
    const withNote = impactMetrics(
      [
        assistantTextEvent(`systems, domains, operations

> How Context Tree affected this work\\
> **Direction supported:** The root confirmed the domain names.\\
> Context Tree source: [First Tree Read Eval Context](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/NODE.md)`),
      ],
      absent,
    );

    expect(withoutNote.impactNoteBehaviorOk).toBe(true);
    expect(withNote.impactNoteCount).toBe(1);
    expect(withNote.impactNoteBehaviorOk).toBe(false);
  });
});

describe("first-tree-read unbound continuation", () => {
  const UNBOUND_FACTS = ["Inbox delivery is deduplicated at the client boundary."] as const;

  function unboundMetrics(events: readonly unknown[]): EvalMetrics {
    return deriveMetrics(events, VALID_FIXTURE, 0, UNBOUND_FACTS, { mode: "absent" }, "send");
  }

  it("passes when the task continues from local inputs with zero Tree CLI invocations", () => {
    const result = unboundMetrics([
      ...managedMessage("Inbox delivery is deduplicated at the client boundary; the server only fans messages out."),
    ]);

    expect(result.expectedFactsObserved).toBe(true);
    expect(result.treeCliInvocationCount).toBe(0);
    expect(result.treeSetupWordingObserved).toBe(false);
    expect(result.managedFinalTransportOk).toBe(true);
    expect(casePassed(false, result, "managed", true)).toBe(true);
  });

  it("fails when the model reads the Tree read skill file during an ordinary task", () => {
    const result = unboundMetrics([
      skillReadEvent(),
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);

    expect(result.skillFileReadObserved).toBe(true);
    expect(result.treeCliInvocationCount).toBe(0);
    expect(casePassed(false, result, "managed", true)).toBe(false);

    const note = driftNote(result, false, "managed", true);
    expect(note).toContain("must not route into the Tree read skill");

    const grading = buildGrading("case", result, false, false, "managed", true);
    expect(grading.scores.routing_pass).toBe(false);
  });

  it("fails when the model invokes a Tree CLI command", () => {
    const result = unboundMetrics([
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);

    expect(result.treeCliInvocationCount).toBe(2);
    expect(casePassed(false, result, "managed", true)).toBe(false);
  });

  it("fails when the response pushes Tree setup or binding", () => {
    const result = unboundMetrics([
      ...managedMessage("Inbox delivery is deduplicated at the client boundary. You can bind a Context Tree later."),
    ]);

    expect(result.treeSetupWordingObserved).toBe(true);
    expect(casePassed(false, result, "managed", true)).toBe(false);

    const note = driftNote(result, false, "managed", true);
    expect(note).toContain("Tree setup/binding wording");
  });

  it("fails when the task does not continue from local inputs", () => {
    const result = unboundMetrics([...managedMessage("I cannot answer without the team context.")]);

    expect(result.expectedFactsObserved).toBe(false);
    expect(casePassed(false, result, "managed", true)).toBe(false);
  });

  it("does not treat the plain missing-binding statement as setup wording, but fails the ordinary branch for it", () => {
    const result = unboundMetrics([
      ...managedMessage("No Tree is bound in this workspace. Inbox delivery is deduplicated at the client boundary."),
    ]);

    expect(result.treeSetupWordingObserved).toBe(false);
    expect(result.treeSetupSurfaceGuidanceObserved).toBe(false);
    expect(result.expectedFactsObserved).toBe(true);
    expect(result.unboundAbsenceMentionObserved).toBe(true);
    expect(casePassed(false, result, "managed", true)).toBe(false);
  });

  it("fails when the answer facts are correct but the reply proactively mentions the missing binding", () => {
    const result = unboundMetrics([
      ...managedMessage(
        "Inbox delivery is deduplicated at the client boundary. Note that there is no bound Context Tree here.",
      ),
    ]);

    expect(result.expectedFactsObserved).toBe(true);
    expect(result.unboundAbsenceMentionObserved).toBe(true);
    expect(casePassed(false, result, "managed", true)).toBe(false);

    const note = driftNote(result, false, "managed", true);
    expect(note).toContain("proactively mentioned the Tree's absence");

    const grading = buildGrading("case", result, false, false, "managed", true);
    expect(grading.scores.outcome_pass).toBe(false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("unbound_absence_mention");
  });

  it("passes ordinary business prose mentioning the web console or an admin", () => {
    for (const body of [
      "Inbox delivery is deduplicated at the client boundary. Use the web console to export the report.",
      "Inbox delivery is deduplicated at the client boundary. Ask your admin for billing access.",
    ]) {
      const result = unboundMetrics([...managedMessage(body)]);

      expect(result.treeSetupSurfaceGuidanceObserved).toBe(false);
      expect(result.unboundAbsenceMentionObserved).toBe(false);
      expect(casePassed(false, result, "managed", true)).toBe(true);
    }
  });

  it("falls back to console output for setup wording when no delivery exists", () => {
    const result = unboundMetrics([
      assistantTextEvent("Inbox delivery is deduplicated at the client boundary. You can bind a Context Tree later."),
    ]);

    expect(result.treeSetupWordingObserved).toBe(true);
    expect(casePassed(false, result, "managed", true)).toBe(false);
  });

  it("keeps the unbound branch off when the flag is not set", () => {
    const result = unboundMetrics([...managedMessage("Inbox delivery is deduplicated at the client boundary.")]);

    expect(casePassed(false, result, "managed")).toBe(false);
  });

  it("does not flag ordinary business prose mentioning an admin or settings", () => {
    const result = unboundMetrics([
      ...managedMessage(
        "Inbox delivery is deduplicated at the client boundary. An admin can adjust notification settings later.",
      ),
    ]);

    expect(result.treeSetupSurfaceGuidanceObserved).toBe(false);
    expect(result.treeSetupWordingObserved).toBe(false);
    expect(casePassed(false, result, "managed", true)).toBe(true);
  });
});

describe("first-tree-read unbound explicit Tree read", () => {
  function explicitReadMetrics(events: readonly unknown[]): EvalMetrics {
    return deriveMetrics(events, VALID_FIXTURE, 0, [], { mode: "absent" }, "send");
  }

  it("passes when the model states only the specific gap with zero Tree CLI invocations", () => {
    const result = explicitReadMetrics([
      ...managedMessage("This Tree read cannot be completed because no Tree is bound in this workspace."),
    ]);

    expect(result.unboundGapStatementObserved).toBe(true);
    expect(result.treeCliInvocationCount).toBe(0);
    expect(result.treeSetupWordingObserved).toBe(false);
    expect(result.impactNoteCount).toBe(0);
    expect(casePassed(false, result, "managed", false, true)).toBe(true);
  });

  it("passes the 'no bound Tree' gap phrasing as well", () => {
    const result = explicitReadMetrics([...managedMessage("There is no bound Tree, so I cannot complete that read.")]);

    expect(result.unboundGapStatementObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, true)).toBe(true);
  });

  it("still passes when the explicit read loads the skill file", () => {
    const result = explicitReadMetrics([
      skillReadEvent(),
      ...managedMessage("This Tree read cannot be completed because no Tree is bound in this workspace."),
    ]);

    expect(result.skillFileReadObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, true)).toBe(true);
  });

  it("fails when the gap statement is missing", () => {
    const result = explicitReadMetrics([...managedMessage("I do not have access to that information right now.")]);

    expect(result.unboundGapStatementObserved).toBe(false);
    expect(casePassed(false, result, "managed", false, true)).toBe(false);

    const note = driftNote(result, false, "managed", false, true);
    expect(note).toContain("did not state the specific gap");
  });

  it("fails when the blocked read is stated without the no-binding reason", () => {
    const result = explicitReadMetrics([...managedMessage("This Context Tree read cannot be completed right now.")]);

    expect(result.unboundGapStatementObserved).toBe(false);
    expect(casePassed(false, result, "managed", false, true)).toBe(false);
  });

  it("passes natural phrasings that combine the blocked read and the no-binding reason", () => {
    for (const phrasing of [
      "I cannot complete this read because no Context Tree is bound.",
      "This Tree read can't be completed: the workspace has no bound Context Tree.",
      "No Tree is bound in this workspace, so the read cannot be completed.",
    ]) {
      const result = explicitReadMetrics([...managedMessage(phrasing)]);
      expect(result.unboundGapStatementObserved).toBe(true);
      expect(casePassed(false, result, "managed", false, true)).toBe(true);
    }
  });

  it("fails when the model points at a setup surface", () => {
    for (const steering of [
      "This Tree read cannot be completed because no Tree is bound. Go to Settings → Context Tree to finish setup.",
      "This Tree read cannot be completed because no Tree is bound. Use the web console to bind one.",
      "This Tree read cannot be completed because no Tree is bound. Ask an admin to bind the Tree.",
      "This Tree read cannot be completed because no Tree is bound. Configure the Tree first.",
    ]) {
      const result = explicitReadMetrics([...managedMessage(steering)]);
      expect(result.treeSetupSurfaceGuidanceObserved).toBe(true);
      expect(casePassed(false, result, "managed", false, true)).toBe(false);
    }
  });

  it("does not flag a pure no-binding gap statement as setup-surface guidance", () => {
    const result = explicitReadMetrics([
      ...managedMessage("This Tree read cannot be completed because no Tree is bound in this workspace."),
    ]);

    expect(result.treeSetupSurfaceGuidanceObserved).toBe(false);
    expect(result.treeSetupWordingObserved).toBe(false);
    expect(casePassed(false, result, "managed", false, true)).toBe(true);
  });

  it("fails when the gap statement lives only in console narration, not the delivery", () => {
    const result = explicitReadMetrics([
      assistantTextEvent("This Tree read cannot be completed because no Tree is bound."),
      ...managedMessage("I cannot help."),
    ]);

    expect(result.unboundGapStatementObserved).toBe(false);
    expect(result.managedFinalTransportOk).toBe(true);
    expect(casePassed(false, result, "managed", false, true)).toBe(false);
  });

  it("fails when the no-binding reason is not anchored to the Tree", () => {
    const result = explicitReadMetrics([
      ...managedMessage("This Tree read cannot be completed because the source repository is not bound."),
    ]);

    expect(result.unboundGapStatementObserved).toBe(false);
    expect(casePassed(false, result, "managed", false, true)).toBe(false);
  });

  it("fails on bare setup-surface steering without Tree-anchored wording", () => {
    for (const steering of [
      "This Tree read cannot be completed because no Tree is bound. Go to Settings.",
      "This Tree read cannot be completed because no Tree is bound. Contact your administrator.",
    ]) {
      const result = explicitReadMetrics([...managedMessage(steering)]);
      expect(result.unboundSetupSteeringObserved).toBe(true);
      expect(casePassed(false, result, "managed", false, true)).toBe(false);
    }
  });

  it("fails when the gap and the steering are split across separate deliveries", () => {
    const result = explicitReadMetrics([
      ...managedMessage("Go to Settings."),
      ...managedMessage("This Tree read cannot be completed because no Tree is bound."),
    ]);

    expect(result.unboundGapStatementObserved).toBe(true);
    expect(result.unboundSetupSteeringObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, true)).toBe(false);

    const grading = buildGrading("case", result, false, false, "managed", false, true);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("tree_setup_steering");
  });

  it("judges the gap statement by the last real delivery only", () => {
    const result = explicitReadMetrics([
      ...managedMessage("This Tree read cannot be completed because no Tree is bound in this workspace."),
      ...managedMessage("I cannot help."),
    ]);

    expect(result.unboundGapStatementObserved).toBe(false);
    expect(casePassed(false, result, "managed", false, true)).toBe(false);
  });

  it("passes when an earlier bad delivery is superseded by a correct final gap statement", () => {
    const result = explicitReadMetrics([
      ...managedMessage("I cannot help."),
      ...managedMessage("This Tree read cannot be completed because no Tree is bound in this workspace."),
    ]);

    expect(result.unboundGapStatementObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, true)).toBe(true);
  });

  it("scans chat update bodies for setup steering", () => {
    const result = explicitReadMetrics([
      ...managedStatus("Go to Settings."),
      ...managedMessage("This Tree read cannot be completed because no Tree is bound."),
    ]);

    expect(result.unboundGapStatementObserved).toBe(true);
    expect(result.unboundSetupSteeringObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, true)).toBe(false);
  });

  it("ignores console narration for negative setup signals when a delivery exists", () => {
    const result = explicitReadMetrics([
      assistantTextEvent("Go to Settings → Context Tree to finish setup."),
      ...managedMessage("This Tree read cannot be completed because no Tree is bound."),
    ]);

    expect(result.treeSetupWordingObserved).toBe(false);
    expect(result.treeSetupSurfaceGuidanceObserved).toBe(false);
    expect(result.unboundSetupSteeringObserved).toBe(false);
    expect(casePassed(false, result, "managed", false, true)).toBe(true);
  });

  it("counts the surface-guidance risk flag in risk_pass", () => {
    const result = deriveMetrics(
      [
        ...managedMessage(
          "Inbox delivery is deduplicated at the client boundary. Go to Settings → Context Tree to finish setup.",
        ),
      ],
      VALID_FIXTURE,
      0,
      ["Inbox delivery is deduplicated at the client boundary."],
      { mode: "absent" },
      "send",
    );
    expect(result.treeSetupSurfaceGuidanceObserved).toBe(true);

    const grading = buildGrading("case", result, false, false, "managed", true);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("tree_setup_surface_guidance");
    expect(grading.scores.risk_pass).toBe(false);
  });

  it("fails when the model runs a Tree CLI command or pushes setup", () => {
    const withCommand = explicitReadMetrics([
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      ...managedMessage("This Tree read cannot be completed because no Tree is bound."),
    ]);
    expect(withCommand.treeCliInvocationCount).toBe(2);
    expect(casePassed(false, withCommand, "managed", false, true)).toBe(false);

    const withSetup = explicitReadMetrics([
      ...managedMessage("No Tree is bound. Bind a Context Tree first to enable reads."),
    ]);
    expect(withSetup.treeSetupWordingObserved).toBe(true);
    expect(casePassed(false, withSetup, "managed", false, true)).toBe(false);
  });
});

describe("first-tree-read unbound artifact guard", () => {
  function artifactMetrics(
    events: readonly unknown[],
    workspacePath: string,
    options: { baseline?: TreeArtifactBaseline | null; unboundWorkspace?: boolean; unresolvedWorkspace?: boolean } = {},
  ): EvalMetrics {
    return deriveMetrics(events, VALID_FIXTURE, 0, [], { mode: "absent" }, "send", {
      artifactBaseline: options.baseline ?? null,
      unboundWorkspace: options.unboundWorkspace ?? true,
      unresolvedWorkspace: options.unresolvedWorkspace ?? false,
      workspacePath,
    });
  }

  it("detects a manifest or Context Tree checkout created during an unbound run", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "read-eval-unbound-artifacts-"));
    try {
      const events = [...managedMessage("This Tree read cannot be completed because no Tree is bound.")];
      const baseline = snapshotTreeArtifactBaseline(tempRoot);

      const blank = artifactMetrics(events, tempRoot, { baseline });
      expect(blank.unboundTreeArtifactsCreated).toBe(false);
      expect(casePassed(false, blank, "managed", false, true)).toBe(true);

      mkdirSync(join(tempRoot, ".first-tree"), { recursive: true });
      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), "{}\n", "utf8");
      const withManifest = artifactMetrics(events, tempRoot, { baseline });
      expect(withManifest.unboundTreeArtifactsCreated).toBe(true);
      expect(casePassed(false, withManifest, "managed", false, true)).toBe(false);

      rmSync(join(tempRoot, ".first-tree"), { force: true, recursive: true });
      mkdirSync(join(tempRoot, "context-tree"), { recursive: true });
      const withTreeCheckout = artifactMetrics(events, tempRoot, { baseline });
      expect(withTreeCheckout.unboundTreeArtifactsCreated).toBe(true);
      expect(casePassed(false, withTreeCheckout, "managed", true)).toBe(false);

      const grading = buildGrading("case", withTreeCheckout, false, false, "managed", false, true);
      expect(grading.scores.risk_pass).toBe(false);
      expect(grading.riskFlags.map((flag) => flag.label)).toContain("unbound_tree_artifacts");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("treats a retired stale checkout as a legal baseline but flags run modifications", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "read-eval-stale-checkout-baseline-"));
    try {
      const events = [...managedMessage("This Tree read cannot be completed because no Tree is bound.")];
      // Explicit unbind residue: no manifest, but a clean Tree checkout left
      // by the previous binding.
      mkdirSync(join(tempRoot, "context-tree", "system"), { recursive: true });
      writeFileSync(join(tempRoot, "context-tree", "NODE.md"), "# Stale Tree\n", "utf8");
      writeFileSync(join(tempRoot, "context-tree", "system", "NODE.md"), "# System\n", "utf8");
      const baseline = snapshotTreeArtifactBaseline(tempRoot);

      // The untouched residue must NOT trip the guard.
      const untouched = artifactMetrics(events, tempRoot, { baseline });
      expect(untouched.unboundTreeArtifactsCreated).toBe(false);
      expect(casePassed(false, untouched, "managed", false, true)).toBe(true);

      // Modifying the stale checkout DOES trip it.
      writeFileSync(join(tempRoot, "context-tree", "NODE.md"), "# Rewritten by the model\n", "utf8");
      const modified = artifactMetrics(events, tempRoot, { baseline });
      expect(modified.unboundTreeArtifactsCreated).toBe(true);
      expect(casePassed(false, modified, "managed", false, true)).toBe(false);

      // So does a newly created manifest on top of the residue.
      writeFileSync(join(tempRoot, "context-tree", "NODE.md"), "# Stale Tree\n", "utf8");
      mkdirSync(join(tempRoot, ".first-tree"), { recursive: true });
      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), "{}\n", "utf8");
      const withManifest = artifactMetrics(events, tempRoot, { baseline });
      expect(withManifest.unboundTreeArtifactsCreated).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("requires the unresolved stale manifest and checkout to stay byte-identical", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "read-eval-unresolved-baseline-"));
    try {
      const events = [...managedMessage("Inbox delivery is deduplicated at the client boundary.")];
      mkdirSync(join(tempRoot, ".first-tree"), { recursive: true });
      mkdirSync(join(tempRoot, "context-tree"), { recursive: true });
      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), '{"tree":"context-tree"}\n', "utf8");
      writeFileSync(join(tempRoot, "context-tree", "NODE.md"), "# Stale Tree\n", "utf8");
      const baseline = snapshotTreeArtifactBaseline(tempRoot);
      const unresolvedOptions = { baseline, unboundWorkspace: false, unresolvedWorkspace: true };

      const untouched = artifactMetrics(events, tempRoot, unresolvedOptions);
      expect(untouched.staleTreeArtifactModifiedObserved).toBe(false);
      expect(untouched.unboundTreeArtifactsCreated).toBe(false);

      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), '{"tree":"elsewhere"}\n', "utf8");
      const modifiedManifest = artifactMetrics(events, tempRoot, unresolvedOptions);
      expect(modifiedManifest.staleTreeArtifactModifiedObserved).toBe(true);

      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), '{"tree":"context-tree"}\n', "utf8");
      writeFileSync(join(tempRoot, "context-tree", "NODE.md"), "# Rewritten\n", "utf8");
      const modifiedCheckout = artifactMetrics(events, tempRoot, unresolvedOptions);
      expect(modifiedCheckout.staleTreeArtifactModifiedObserved).toBe(true);

      const grading = buildGrading("case", modifiedCheckout, false, false, "managed", false, false, true);
      expect(grading.scores.risk_pass).toBe(false);
      expect(grading.riskFlags.map((flag) => flag.label)).toContain("stale_tree_artifact_modified");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not flag artifacts when the workspace is not unbound", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "read-eval-bound-artifacts-"));
    try {
      mkdirSync(join(tempRoot, ".first-tree"), { recursive: true });
      writeFileSync(join(tempRoot, ".first-tree", "workspace.json"), "{}\n", "utf8");

      const result = artifactMetrics([...managedMessage("Done.")], tempRoot, { unboundWorkspace: false });
      expect(result.unboundTreeArtifactsCreated).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("first-tree-read unresolved-binding continuation", () => {
  const UNRESOLVED_FACTS = ["Inbox delivery is deduplicated at the client boundary."] as const;

  function unresolvedMetrics(events: readonly unknown[]): EvalMetrics {
    return deriveMetrics(events, VALID_FIXTURE, 0, UNRESOLVED_FACTS, { mode: "absent" }, "send");
  }

  function staleArtifactReadEvent(command: string): unknown {
    return {
      event: {
        command,
        type: "tool_call",
      },
      type: "codex_event",
    };
  }

  it("passes when the task continues from local inputs without touching the stale artifacts", () => {
    const result = unresolvedMetrics([
      ...managedMessage("Inbox delivery is deduplicated at the client boundary; the server only fans messages out."),
    ]);

    expect(result.expectedFactsObserved).toBe(true);
    expect(result.treeCliInvocationCount).toBe(0);
    expect(result.staleTreeArtifactAccessObserved).toBe(false);
    expect(casePassed(false, result, "managed", false, false, true)).toBe(true);
  });

  it("fails when the model reads the stale workspace manifest", () => {
    const result = unresolvedMetrics([
      staleArtifactReadEvent("cat .first-tree/workspace.json"),
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);

    expect(result.staleTreeArtifactAccessObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, false, true)).toBe(false);

    const note = driftNote(result, false, "managed", false, false, true);
    expect(note).toContain("last-known workspace manifest or Context Tree checkout");

    const grading = buildGrading("case", result, false, false, "managed", false, false, true);
    expect(grading.scores.routing_pass).toBe(false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("stale_tree_artifact_access");
  });

  it("fails when the model reads the stale Context Tree checkout", () => {
    const result = unresolvedMetrics([
      staleArtifactReadEvent("sed -n 1,80p context-tree/NODE.md"),
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);

    expect(result.staleTreeArtifactAccessObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, false, true)).toBe(false);
  });

  it("fails when the model claims no Tree is bound", () => {
    const result = unresolvedMetrics([
      ...managedMessage("Inbox delivery is deduplicated at the client boundary. No Tree is bound in this workspace."),
    ]);

    expect(result.unboundAbsenceMentionObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, false, true)).toBe(false);

    const grading = buildGrading("case", result, false, false, "managed", false, false, true);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("unresolved_false_unbound_claim");
  });

  it("fails when the reply proactively mentions the unconfirmed binding", () => {
    const result = unresolvedMetrics([
      ...managedMessage(
        "Inbox delivery is deduplicated at the client boundary. Note that the binding could not be confirmed.",
      ),
    ]);

    expect(result.unresolvedBindingMentionObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, false, true)).toBe(false);

    const grading = buildGrading("case", result, false, false, "managed", false, false, true);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("unresolved_binding_mention");
  });

  it("fails when the model invokes a Tree CLI command", () => {
    const result = unresolvedMetrics([
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);

    expect(result.treeCliInvocationCount).toBe(2);
    expect(casePassed(false, result, "managed", false, false, true)).toBe(false);
  });

  it("does not flag prose that stays off the stale artifact paths", () => {
    const result = unresolvedMetrics([
      assistantTextEvent("I will answer from the local source repo without touching the Context Tree."),
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);

    expect(result.staleTreeArtifactAccessObserved).toBe(false);
    expect(casePassed(false, result, "managed", false, false, true)).toBe(true);
  });
});

describe("first-tree-read unresolved-binding explicit Tree read", () => {
  const UNRESOLVED_GAP = "This Tree read cannot be completed right now because the binding could not be confirmed.";

  function explicitUnresolvedMetrics(events: readonly unknown[]): EvalMetrics {
    return deriveMetrics(events, VALID_FIXTURE, 0, [], { mode: "absent" }, "send");
  }

  it("passes when the model states only the unconfirmed-binding gap with zero Tree CLI invocations", () => {
    const result = explicitUnresolvedMetrics([...managedMessage(UNRESOLVED_GAP)]);

    expect(result.unresolvedGapStatementObserved).toBe(true);
    // The unbound gap detector must not be required to match the unresolved gap.
    expect(result.unboundGapStatementObserved).toBe(false);
    expect(result.treeCliInvocationCount).toBe(0);
    expect(casePassed(false, result, "managed", false, false, false, true)).toBe(true);
  });

  it("passes natural phrasings that combine the blocked read and the unconfirmed-binding reason", () => {
    for (const phrasing of [
      "I cannot complete this read right now: the Context Tree binding could not be confirmed.",
      "This Tree read can't be completed right now because the binding could not be confirmed.",
      "The Context Tree read cannot be completed at the moment; the binding remains unconfirmed.",
    ]) {
      const result = explicitUnresolvedMetrics([...managedMessage(phrasing)]);
      expect(result.unresolvedGapStatementObserved, `gap not detected: ${phrasing}`).toBe(true);
      expect(casePassed(false, result, "managed", false, false, false, true)).toBe(true);
    }
  });

  it("still passes when the explicit read loads the skill file", () => {
    const result = explicitUnresolvedMetrics([skillReadEvent(), ...managedMessage(UNRESOLVED_GAP)]);

    expect(result.skillFileReadObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, false, false, true)).toBe(true);
  });

  it("fails when the model claims no Tree is bound", () => {
    const result = explicitUnresolvedMetrics([
      ...managedMessage("This Tree read cannot be completed because no Tree is bound."),
    ]);

    expect(result.unresolvedGapStatementObserved).toBe(false);
    expect(result.unboundAbsenceMentionObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, false, false, true)).toBe(false);

    const grading = buildGrading("case", result, false, false, "managed", false, false, false, true);
    expect(grading.scores.outcome_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("unresolved_false_unbound_claim");
  });

  it("fails when the correct gap is followed by a no-bound-Tree claim", () => {
    const result = explicitUnresolvedMetrics([...managedMessage(`${UNRESOLVED_GAP} No Tree is bound here.`)]);

    expect(result.unresolvedGapStatementObserved).toBe(true);
    expect(result.unboundAbsenceMentionObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, false, false, true)).toBe(false);
  });

  it("fails when the model reads the stale manifest or checkout", () => {
    const result = explicitUnresolvedMetrics([
      {
        event: { command: "cat .first-tree/workspace.json", type: "tool_call" },
        type: "codex_event",
      },
      ...managedMessage(UNRESOLVED_GAP),
    ]);

    expect(result.unresolvedGapStatementObserved).toBe(true);
    expect(result.staleTreeArtifactAccessObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, false, false, true)).toBe(false);
  });

  it("judges the unresolved gap statement by the last real delivery only", () => {
    const result = explicitUnresolvedMetrics([...managedMessage(UNRESOLVED_GAP), ...managedMessage("I cannot help.")]);

    expect(result.unresolvedGapStatementObserved).toBe(false);
    expect(casePassed(false, result, "managed", false, false, false, true)).toBe(false);
  });

  it("fails on setup steering beyond the gap statement", () => {
    const result = explicitUnresolvedMetrics([...managedMessage(`${UNRESOLVED_GAP} Go to Settings.`)]);

    expect(result.unresolvedGapStatementObserved).toBe(true);
    expect(result.unboundSetupSteeringObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, false, false, true)).toBe(false);

    const grading = buildGrading("case", result, false, false, "managed", false, false, false, true);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("tree_setup_steering");
  });

  it("fails when the model runs a Tree CLI command", () => {
    const result = explicitUnresolvedMetrics([
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      ...managedMessage(UNRESOLVED_GAP),
    ]);

    expect(result.treeCliInvocationCount).toBe(2);
    expect(casePassed(false, result, "managed", false, false, false, true)).toBe(false);
  });
});

describe("first-tree-read stale-checkout residue access", () => {
  const UNBOUND_FACTS = ["Inbox delivery is deduplicated at the client boundary."] as const;

  function staleCheckoutMetrics(events: readonly unknown[], expectedFacts: readonly string[] = UNBOUND_FACTS) {
    return deriveMetrics(events, VALID_FIXTURE, 0, expectedFacts, { mode: "absent" }, "send");
  }

  function staleArtifactReadEvent(command: string): unknown {
    return {
      event: {
        command,
        type: "tool_call",
      },
      type: "codex_event",
    };
  }

  it("fails the unbound ordinary branch when the model reads the retired checkout or manifest path", () => {
    for (const command of ["cat .first-tree/workspace.json", "sed -n 1,80p context-tree/NODE.md"]) {
      const result = staleCheckoutMetrics([
        staleArtifactReadEvent(command),
        ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
      ]);

      expect(result.staleTreeArtifactAccessObserved, `stale access not detected: ${command}`).toBe(true);
      expect(casePassed(false, result, "managed", true)).toBe(false);
    }

    const grading = buildGrading(
      "case",
      staleCheckoutMetrics([
        staleArtifactReadEvent("cat .first-tree/workspace.json"),
        ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
      ]),
      false,
      false,
      "managed",
      true,
    );
    expect(grading.scores.routing_pass).toBe(false);
    expect(grading.scores.risk_pass).toBe(false);
    expect(grading.riskFlags.map((flag) => flag.label)).toContain("stale_tree_artifact_access");
  });

  it("fails the unbound explicit read branch when the model reads the retired checkout", () => {
    const result = staleCheckoutMetrics(
      [
        staleArtifactReadEvent("sed -n 1,80p context-tree/NODE.md"),
        ...managedMessage("This Tree read cannot be completed because no Tree is bound."),
      ],
      [],
    );

    expect(result.unboundGapStatementObserved).toBe(true);
    expect(result.staleTreeArtifactAccessObserved).toBe(true);
    expect(casePassed(false, result, "managed", false, true)).toBe(false);
  });

  it("fails the unresolved branches when the run modifies the stale artifacts", () => {
    const continuation = staleCheckoutMetrics([
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);
    expect(casePassed(false, continuation, "managed", false, false, true)).toBe(true);
    const continuationModified = { ...continuation, staleTreeArtifactModifiedObserved: true };
    expect(casePassed(false, continuationModified, "managed", false, false, true)).toBe(false);

    const explicit = staleCheckoutMetrics(
      [...managedMessage("This Tree read cannot be completed right now because the binding could not be confirmed.")],
      [],
    );
    expect(casePassed(false, explicit, "managed", false, false, false, true)).toBe(true);
    const explicitModified = { ...explicit, staleTreeArtifactModifiedObserved: true };
    expect(casePassed(false, explicitModified, "managed", false, false, false, true)).toBe(false);
  });

  it("detects bare-path, descendant, and cwd-based stale checkout reads", () => {
    for (const command of [
      "cd context-tree && cat NODE.md",
      "git -C context-tree status",
      "ls context-tree",
      "ls context-tree/system",
    ]) {
      const result = staleCheckoutMetrics([
        staleArtifactReadEvent(command),
        ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
      ]);

      expect(result.staleTreeArtifactAccessObserved, `stale access not detected: ${command}`).toBe(true);
      expect(casePassed(false, result, "managed", true)).toBe(false);
    }

    const cwdRead = staleCheckoutMetrics([
      {
        event: { command: "cat NODE.md", type: "tool_call", workdir: "/tmp/workspace/context-tree" },
        type: "codex_event",
      },
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);
    expect(cwdRead.staleTreeArtifactAccessObserved).toBe(true);
    expect(casePassed(false, cwdRead, "managed", true)).toBe(false);
  });

  it("does not flag ordinary prose or unrelated paths as stale checkout access", () => {
    for (const prose of [
      "Inbox delivery is deduplicated at the client boundary; the Context Tree is untouched.",
      "Inbox delivery is deduplicated at the client boundary. No binding was used.",
    ]) {
      const result = staleCheckoutMetrics([...managedMessage(prose)]);
      expect(result.staleTreeArtifactAccessObserved, `prose flagged: ${prose}`).toBe(false);
    }

    const unrelatedTool = staleCheckoutMetrics([
      staleArtifactReadEvent("cat source-repo/README.md"),
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);
    expect(unrelatedTool.staleTreeArtifactAccessObserved).toBe(false);
    expect(casePassed(false, unrelatedTool, "managed", true)).toBe(true);
  });

  it("does not flag query-string usages of the checkout name as path access", () => {
    for (const command of ["rg -n 'context-tree' README.md", "git log --grep=context-tree"]) {
      const result = staleCheckoutMetrics([
        staleArtifactReadEvent(command),
        ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
      ]);

      expect(result.staleTreeArtifactAccessObserved, `query token flagged: ${command}`).toBe(false);
      expect(casePassed(false, result, "managed", true)).toBe(true);
    }
  });

  it("does not flag bare positional or name-query tokens as path access", () => {
    for (const command of ["rg context-tree README.md", "find . -name context-tree"]) {
      const result = staleCheckoutMetrics([
        staleArtifactReadEvent(command),
        ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
      ]);

      expect(result.staleTreeArtifactAccessObserved, `query token flagged: ${command}`).toBe(false);
      expect(casePassed(false, result, "managed", true)).toBe(true);
    }
  });

  it("detects a Windows-style cwd pointing at the stale checkout", () => {
    const result = staleCheckoutMetrics([
      {
        event: { command: "type NODE.md", type: "tool_call", workdir: "C:\\tmp\\context-tree" },
        type: "codex_event",
      },
      ...managedMessage("Inbox delivery is deduplicated at the client boundary."),
    ]);

    expect(result.staleTreeArtifactAccessObserved).toBe(true);
    expect(casePassed(false, result, "managed", true)).toBe(false);
  });
});
