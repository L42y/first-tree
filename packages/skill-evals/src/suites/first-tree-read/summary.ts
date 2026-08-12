import { writeFileSync } from "node:fs";

import { evidence, gradingMarkdownRows, riskFlag, writeGradingJson } from "../../core/grading.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { BatchSummary, CaseRunSummary, EvalMetrics, FixtureValidation, ReadMode } from "./types.js";

const HELP_ARGV = ["tree", "tree", "--help"];

function markdownBool(value: boolean): string {
  return value ? "true" : "false";
}

function argvEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isHelpArgv(argv: readonly string[]): boolean {
  return argvEquals(argv, HELP_ARGV);
}

function isTreeTreeArgv(argv: readonly string[]): boolean {
  return argv[0] === "tree" && argv[1] === "tree";
}

function isTreeSelectorArgv(argv: readonly string[]): boolean {
  return isTreeTreeArgv(argv) && !isHelpArgv(argv);
}

function formatArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(arg)) return arg;
  return JSON.stringify(arg);
}

function formatCommand(argv: readonly string[]): string {
  return argv.map(formatArg).join(" ");
}

export function driftNote(
  metrics: EvalMetrics,
  expectedTrigger: boolean,
  readMode: ReadMode = "managed",
  unboundContinuation = false,
  unboundExplicitRead = false,
  unresolvedContinuation = false,
  unresolvedExplicitRead = false,
): string | null {
  const unbound = unboundContinuation || unboundExplicitRead;
  const unresolved = unresolvedContinuation || unresolvedExplicitRead;
  const treeless = unbound || unresolved;
  const notes: string[] = [];
  const nonZeroResults = metrics.firstTreeCommandResults.filter((result) => result.exitCode !== 0);
  const selectorCallCount = metrics.firstTreeArgv.filter(isTreeSelectorArgv).length;
  const selectorExitCodes = metrics.firstTreeCommandResults
    .filter((result) => isTreeSelectorArgv(result.argv))
    .map((result) => result.exitCode);

  if (nonZeroResults.length > 0) {
    const detail = nonZeroResults
      .map((result) => `first-tree ${formatCommand(result.argv)} => ${result.exitCode}`)
      .join("; ");
    notes.push(`first-tree command(s) returned non-zero exit code(s): ${detail}.`);
  }

  if (expectedTrigger && !metrics.helpSucceeded) {
    if (!metrics.helpAttempted && metrics.helpExitCodes.length === 0) {
      notes.push("Required first-tree tree tree --help command did not run during model phase.");
    } else {
      const exitCodes = metrics.helpExitCodes.length > 0 ? metrics.helpExitCodes.join(", ") : "none";
      notes.push(`Required first-tree tree tree --help command did not succeed; observed exit code(s): ${exitCodes}.`);
    }
  }

  if (expectedTrigger && !metrics.selectionSucceeded) {
    if (selectorCallCount === 0 && selectorExitCodes.length === 0) {
      notes.push("Required first-tree tree tree selector command did not run during model phase.");
    } else {
      const exitCodes = selectorExitCodes.length > 0 ? selectorExitCodes.join(", ") : "none";
      notes.push(
        `Required first-tree tree tree selector command did not succeed; observed exit code(s): ${exitCodes}.`,
      );
    }
  }

  if (expectedTrigger && readMode === "byo") {
    if (!metrics.readRouteSucceeded) {
      notes.push(
        `BYO Read required exactly one successful context route command; observed calls=${metrics.readRouteCalls}.`,
      );
    }
    if (!metrics.readActivationSucceeded) {
      notes.push(`BYO Read required exactly one successful activation; observed calls=${metrics.readActivationCalls}.`);
    }
    if (metrics.legacyReadActivationCalls > 0) {
      notes.push(
        `BYO Read forbids legacy explicit-Team tree read activation; observed calls=${metrics.legacyReadActivationCalls}.`,
      );
    }
    if (!metrics.byoReadSequenceOk) {
      notes.push(
        "BYO Read commands did not follow context route → context snapshot → hierarchy help → selector order.",
      );
    }
    if (!metrics.byoSelectorsNoPull) notes.push("Every BYO hierarchy selector must include --no-pull.");
    if (!metrics.byoSnapshotDetached || !metrics.byoSnapshotExactHeadConsistent) {
      notes.push("BYO selectors did not all observe the activation's exact detached snapshot head.");
    }
  }

  if (expectedTrigger && readMode === "managed" && !metrics.managedFinalTransportOk) {
    notes.push(
      `The task's final managed delivery was ${metrics.managedFinalTransportKind ?? "none"}, but this case requires chat ${metrics.managedTransportExpected ?? "send"}.`,
    );
  }

  if (expectedTrigger && !metrics.expectedFactsObserved) {
    notes.push(
      "Expected Context Tree facts were not surfaced in the model output; inspect events.jsonl for the final assistant messages.",
    );
  }

  if (!metrics.impactNoteBehaviorOk) {
    notes.push(
      `Visible Context Tree impact-note behavior failed: count=${metrics.impactNoteCount}; language=${metrics.impactNoteLanguage ?? "none"}; effect=${metrics.impactNoteEffect ?? "none"}; final end=${metrics.impactNoteAtFinalEnd}; logical lines=${metrics.impactNoteLogicalLinesOk}; blank line=${metrics.impactNoteBlankLineBefore}; objective summary=${metrics.impactNoteSummaryObjectiveOk}; exact links=${metrics.impactNoteExactLinksOk}; source authority=${metrics.impactNoteSourceAuthorityOk}; source labels=${metrics.impactNoteSourceLabels.join(" | ") || "none"}; metadata free=${metrics.impactNoteMetadataFree}; outside blocking ask=${metrics.impactNoteOutsideBlockingAsk}; visible URL credentials absent=${metrics.impactNoteVisibleUrlsCredentialFree}.`,
    );
  }

  if (!expectedTrigger && !treeless && metrics.expectedFactHits.length > 0) {
    notes.push(`Off-topic case surfaced Context Tree fact(s): ${metrics.expectedFactHits.join(" | ")}.`);
  }

  if (unboundContinuation) {
    if (metrics.skillFileReadObserved) {
      notes.push(
        "Unbound ordinary task read first-tree-read/SKILL.md; an ordinary task must not route into the Tree read skill.",
      );
    }
    if (!metrics.expectedFactsObserved) {
      notes.push("Unbound case did not continue the task from local inputs; expected answer facts were not surfaced.");
    }
    if (metrics.unboundAbsenceMentionObserved) {
      notes.push(
        "Unbound ordinary task proactively mentioned the Tree's absence; an ordinary task must stay silent about the missing binding.",
      );
    }
  }

  if (unboundExplicitRead && !metrics.unboundGapStatementObserved) {
    notes.push(
      "Unbound explicit Tree read did not state the specific gap: this read cannot be completed because nothing is bound.",
    );
  }

  if (unresolvedContinuation) {
    if (metrics.skillFileReadObserved) {
      notes.push(
        "Unresolved-binding ordinary task read first-tree-read/SKILL.md; an ordinary task must not route into the Tree read skill.",
      );
    }
    if (!metrics.expectedFactsObserved) {
      notes.push(
        "Unresolved-binding case did not continue the task from local inputs; expected answer facts were not surfaced.",
      );
    }
    if (metrics.unresolvedBindingMentionObserved) {
      notes.push(
        "Unresolved-binding ordinary task proactively mentioned the unconfirmed binding; an ordinary task must stay silent about the binding state.",
      );
    }
  }

  if (unresolvedExplicitRead && !metrics.unresolvedGapStatementObserved) {
    notes.push(
      "Unresolved-binding explicit Tree read did not state the specific gap: this read cannot be completed right now because the binding could not be confirmed.",
    );
  }

  if (unresolved && metrics.unboundAbsenceMentionObserved) {
    notes.push("Unresolved-binding case claimed no Tree is bound; an unconfirmed binding is not a confirmed unbind.");
  }

  if (unresolved && metrics.staleTreeArtifactAccessObserved) {
    notes.push(
      "Unresolved-binding case read or referenced the last-known workspace manifest or Context Tree checkout; this session never confirmed that binding.",
    );
  }

  if (unresolved && metrics.staleTreeArtifactModifiedObserved) {
    notes.push(
      "Unresolved-binding case modified the last-known workspace manifest or Context Tree checkout; stale artifacts must stay byte-identical.",
    );
  }

  if (unbound && metrics.staleTreeArtifactAccessObserved) {
    notes.push(
      "Unbound case read or referenced the retired Context Tree checkout or manifest path; explicit unbind keeps the checkout as inert residue, never as Tree authority.",
    );
  }

  if (treeless) {
    if (metrics.treeCliInvocationCount > 0) {
      notes.push(`Treeless case invoked ${metrics.treeCliInvocationCount} Tree CLI command(s); expected zero.`);
    }
    if (metrics.treeSetupWordingObserved) {
      notes.push("Treeless case response pushed Tree setup/binding wording.");
    }
    if (metrics.treeSetupSurfaceGuidanceObserved) {
      notes.push("Treeless case response pointed the user at a setup surface (Settings, web console, operator/admin).");
    }
    if (unbound && metrics.unboundTreeArtifactsCreated) {
      notes.push("Unbound case created a workspace manifest or Context Tree checkout; expected neither.");
    }
  }

  if ((unboundExplicitRead || unresolvedExplicitRead) && metrics.unboundSetupSteeringObserved) {
    notes.push(
      "Explicit Tree read without a confirmed binding carried extra setup/recovery steering beyond the gap statement.",
    );
  }

  return notes.length > 0 ? notes.join(" ") : null;
}

export function buildGrading(
  caseId: string,
  metrics: EvalMetrics,
  expectedTrigger: boolean,
  passed: boolean,
  readMode: ReadMode = "managed",
  unboundContinuation = false,
  unboundExplicitRead = false,
  unresolvedContinuation = false,
  unresolvedExplicitRead = false,
): SkillCaseGrading {
  const unbound = unboundContinuation || unboundExplicitRead;
  const unresolved = unresolvedContinuation || unresolvedExplicitRead;
  const treeless = unbound || unresolved;
  const unexpectedReadUse =
    metrics.skillHit || metrics.firstTreeCalls > 0 || metrics.firstTreeCommandResults.length > 0;
  const routingPass = unboundExplicitRead
    ? metrics.treeCliInvocationCount === 0 && !metrics.staleTreeArtifactAccessObserved
    : unboundContinuation
      ? metrics.treeCliInvocationCount === 0 &&
        !metrics.skillFileReadObserved &&
        !metrics.staleTreeArtifactAccessObserved
      : unresolvedExplicitRead
        ? metrics.treeCliInvocationCount === 0 && !metrics.staleTreeArtifactAccessObserved
        : unresolvedContinuation
          ? metrics.treeCliInvocationCount === 0 &&
            !metrics.skillFileReadObserved &&
            !metrics.staleTreeArtifactAccessObserved
          : expectedTrigger
            ? metrics.skillFileReadObserved
            : !unexpectedReadUse;
  const byoProcessPassed =
    readMode === "managed" ||
    (metrics.readRouteSucceeded &&
      metrics.readActivationSucceeded &&
      metrics.byoReadSequenceOk &&
      metrics.byoSelectorsNoPull &&
      metrics.byoSnapshotDetached &&
      metrics.byoSnapshotExactHeadConsistent);
  const managedTransportPassed = readMode === "byo" || metrics.managedFinalTransportOk;
  const processPass = treeless
    ? metrics.fixtureValidationOk &&
      metrics.runnerExitCode === 0 &&
      metrics.treeCliInvocationCount === 0 &&
      metrics.modelFirstTreeCommandsOk &&
      managedTransportPassed
    : expectedTrigger
      ? metrics.fixtureValidationOk &&
        metrics.runnerExitCode === 0 &&
        metrics.helpSucceeded &&
        metrics.selectionSucceeded &&
        metrics.modelFirstTreeCommandsOk &&
        managedTransportPassed &&
        byoProcessPassed
      : metrics.fixtureValidationOk &&
        metrics.runnerExitCode === 0 &&
        metrics.firstTreeCalls === 0 &&
        metrics.firstTreeCommandResults.length === 0 &&
        metrics.modelFirstTreeCommandsOk;
  const outcomePass = unboundExplicitRead
    ? metrics.unboundGapStatementObserved &&
      metrics.impactNoteBehaviorOk &&
      !metrics.treeSetupWordingObserved &&
      !metrics.treeSetupSurfaceGuidanceObserved &&
      !metrics.unboundSetupSteeringObserved
    : unboundContinuation
      ? metrics.expectedFactsObserved &&
        metrics.impactNoteBehaviorOk &&
        !metrics.treeSetupWordingObserved &&
        !metrics.treeSetupSurfaceGuidanceObserved &&
        !metrics.unboundAbsenceMentionObserved
      : unresolvedExplicitRead
        ? metrics.unresolvedGapStatementObserved &&
          metrics.impactNoteBehaviorOk &&
          !metrics.treeSetupWordingObserved &&
          !metrics.treeSetupSurfaceGuidanceObserved &&
          !metrics.unboundSetupSteeringObserved &&
          !metrics.unboundAbsenceMentionObserved
        : unresolvedContinuation
          ? metrics.expectedFactsObserved &&
            metrics.impactNoteBehaviorOk &&
            !metrics.treeSetupWordingObserved &&
            !metrics.treeSetupSurfaceGuidanceObserved &&
            !metrics.unboundAbsenceMentionObserved &&
            !metrics.unresolvedBindingMentionObserved
          : expectedTrigger
            ? metrics.expectedFactsObserved && metrics.impactNoteBehaviorOk
            : metrics.expectedFactHits.length === 0 && metrics.impactNoteBehaviorOk;
  const riskPass =
    metrics.modelFirstTreeCommandsOk &&
    metrics.impactNoteMetadataFree &&
    (!unbound || !metrics.unboundTreeArtifactsCreated) &&
    (!treeless || !metrics.treeSetupSurfaceGuidanceObserved) &&
    (!unboundContinuation || !metrics.unboundAbsenceMentionObserved) &&
    (!unboundExplicitRead || !metrics.unboundSetupSteeringObserved) &&
    (!treeless || !metrics.staleTreeArtifactAccessObserved) &&
    (!unresolved || !metrics.staleTreeArtifactModifiedObserved) &&
    (!unresolved || !metrics.unboundAbsenceMentionObserved) &&
    (!unresolvedContinuation || !metrics.unresolvedBindingMentionObserved) &&
    (!unresolvedExplicitRead || !metrics.unboundSetupSteeringObserved);
  const failedCommands = metrics.firstTreeCommandResults.filter((result) => result.exitCode !== 0);

  return {
    caseId,
    evidence: [
      evidence(
        "routing_pass",
        expectedTrigger
          ? `trigger case skill file read observed=${metrics.skillFileReadObserved}`
          : treeless
            ? `treeless case tree CLI invocations=${metrics.treeCliInvocationCount}; skill file read observed=${metrics.skillFileReadObserved}; stale artifact access observed=${metrics.staleTreeArtifactAccessObserved}`
            : `non-trigger case unexpected skill/tree usage observed=${unexpectedReadUse}`,
      ),
      evidence(
        "process_pass",
        expectedTrigger
          ? `fixture ok=${metrics.fixtureValidationOk}; runner exit=${metrics.runnerExitCode}; read mode=${readMode}; route calls=${metrics.readRouteCalls}; route succeeded=${metrics.readRouteSucceeded}; activation calls=${metrics.readActivationCalls}; activation succeeded=${metrics.readActivationSucceeded}; legacy activation calls=${metrics.legacyReadActivationCalls}; sequence ok=${metrics.byoReadSequenceOk}; selectors no-pull=${metrics.byoSelectorsNoPull}; detached=${metrics.byoSnapshotDetached}; exact head consistent=${metrics.byoSnapshotExactHeadConsistent}; managed final transport ok=${metrics.managedFinalTransportOk}; hierarchy help succeeded=${metrics.helpSucceeded}; selector succeeded=${metrics.selectionSucceeded}; first-tree commands ok=${metrics.modelFirstTreeCommandsOk}`
          : `fixture ok=${metrics.fixtureValidationOk}; runner exit=${metrics.runnerExitCode}; model first-tree calls=${metrics.firstTreeCalls}; first-tree results=${metrics.firstTreeCommandResults.length}`,
      ),
      evidence(
        "outcome_pass",
        expectedTrigger
          ? `expected facts observed=${metrics.expectedFactsObserved}; hits=${metrics.expectedFactHits.join(" | ") || "none"}; impact-note behavior ok=${metrics.impactNoteBehaviorOk}; count=${metrics.impactNoteCount}; effect=${metrics.impactNoteEffect ?? "none"}; language=${metrics.impactNoteLanguage ?? "none"}; outside blocking ask=${metrics.impactNoteOutsideBlockingAsk}; sources=${metrics.impactNoteSourceLabels.join(" | ") || "none"}`
          : `off-topic expected fact hits=${metrics.expectedFactHits.join(" | ") || "none"}; impact-note behavior ok=${metrics.impactNoteBehaviorOk}; count=${metrics.impactNoteCount}`,
      ),
      evidence(
        "risk_pass",
        failedCommands.length === 0 && metrics.impactNoteMetadataFree
          ? "no failed model-phase first-tree commands or visible receipt metadata observed"
          : `failed model-phase first-tree commands=${
              failedCommands.map((result) => `${formatCommand(result.argv)} => ${result.exitCode}`).join("; ") || "none"
            }; visible receipt metadata absent=${metrics.impactNoteMetadataFree}`,
      ),
    ],
    passed,
    riskFlags: [
      ...failedCommands.map((result) =>
        riskFlag("failed_first_tree_command", `first-tree ${formatCommand(result.argv)} exited ${result.exitCode}`),
      ),
      ...(metrics.impactNoteMetadataFree
        ? []
        : [riskFlag("visible_receipt_metadata", "Final visible output included receipt metadata or JSON fields.")]),
      ...(unbound && metrics.unboundTreeArtifactsCreated
        ? [riskFlag("unbound_tree_artifacts", "Unbound case created a workspace manifest or Context Tree checkout.")]
        : []),
      ...(treeless && metrics.treeSetupSurfaceGuidanceObserved
        ? [
            riskFlag(
              "tree_setup_surface_guidance",
              "Treeless case response pointed the user at a setup surface (Settings, web console, operator/admin).",
            ),
          ]
        : []),
      ...(unboundContinuation && metrics.unboundAbsenceMentionObserved
        ? [
            riskFlag(
              "unbound_absence_mention",
              "Unbound ordinary task proactively mentioned the Tree's absence; an ordinary task must stay silent about the missing binding.",
            ),
          ]
        : []),
      ...(unboundExplicitRead && metrics.unboundSetupSteeringObserved
        ? [
            riskFlag(
              "tree_setup_steering",
              "Unbound explicit Tree read carried extra setup/recovery steering beyond the gap statement.",
            ),
          ]
        : []),
      ...(unresolved && metrics.staleTreeArtifactAccessObserved
        ? [
            riskFlag(
              "stale_tree_artifact_access",
              "Unresolved-binding case read or referenced the last-known workspace manifest or Context Tree checkout.",
            ),
          ]
        : []),
      ...(unresolved && metrics.staleTreeArtifactModifiedObserved
        ? [
            riskFlag(
              "stale_tree_artifact_modified",
              "Unresolved-binding case modified the last-known workspace manifest or Context Tree checkout; stale artifacts must stay byte-identical.",
            ),
          ]
        : []),
      ...(unbound && metrics.staleTreeArtifactAccessObserved
        ? [
            riskFlag(
              "stale_tree_artifact_access",
              "Unbound case read or referenced the retired Context Tree checkout or manifest path; it is inert residue, never Tree authority.",
            ),
          ]
        : []),
      ...(unresolved && metrics.unboundAbsenceMentionObserved
        ? [
            riskFlag(
              "unresolved_false_unbound_claim",
              "Unresolved-binding case claimed no Tree is bound; an unconfirmed binding is not a confirmed unbind.",
            ),
          ]
        : []),
      ...(unresolvedContinuation && metrics.unresolvedBindingMentionObserved
        ? [
            riskFlag(
              "unresolved_binding_mention",
              "Unresolved-binding ordinary task proactively mentioned the unconfirmed binding; an ordinary task must stay silent about the binding state.",
            ),
          ]
        : []),
      ...(unresolvedExplicitRead && metrics.unboundSetupSteeringObserved
        ? [
            riskFlag(
              "tree_setup_steering",
              "Unresolved-binding explicit Tree read carried extra setup/recovery steering beyond the gap statement.",
            ),
          ]
        : []),
    ],
    scores: {
      outcome_pass: outcomePass,
      process_pass: processPass,
      risk_pass: riskPass,
      routing_pass: routingPass,
    },
  };
}

function validationRows(validation: FixtureValidation): string {
  return [
    `- ok: ${markdownBool(validation.ok)}`,
    `- domainNodeCount: ${validation.domainNodeCount}`,
    `- minDepthOk: ${markdownBool(validation.minDepthOk)}`,
    `- requiredFilesOk: ${markdownBool(validation.requiredFilesOk)}`,
    `- verifyExitCode: ${validation.verifyResult ? validation.verifyResult.exitCode : "n/a"}`,
    ...validation.errors.map((error) => `- error: ${error}`),
  ].join("\n");
}

function commandResultRows(metrics: EvalMetrics): string {
  if (metrics.firstTreeCommandResults.length === 0) return "- none";
  return metrics.firstTreeCommandResults
    .map((result) => `- first-tree ${formatCommand(result.argv)}: exit=${result.exitCode}`)
    .join("\n");
}

function expectedFactRows(metrics: EvalMetrics): string {
  if (metrics.expectedFactHits.length === 0) return "- none";
  return metrics.expectedFactHits.map((fact) => `- ${fact}`).join("\n");
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeGradingJson(summary.gradingJsonPath, summary.grading);
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const drift = summary.driftNote ? `\n## Drift Evidence\n\n${summary.driftNote}\n` : "";
  const markdown = `# first-tree-read Eval: ${summary.caseId}

## Result

- passed: ${markdownBool(summary.passed)}
- expectedTrigger: ${markdownBool(summary.expectedTrigger)}
- readMode: ${summary.readMode}
- skillHit: ${markdownBool(summary.metrics.skillHit)}
- skillFileReadObserved: ${markdownBool(summary.metrics.skillFileReadObserved)}
- expectedFactsObserved: ${markdownBool(summary.metrics.expectedFactsObserved)}
- impactNoteBehaviorOk: ${markdownBool(summary.metrics.impactNoteBehaviorOk)}
- impactNoteAtFinalEnd: ${markdownBool(summary.metrics.impactNoteAtFinalEnd)}
- impactNoteCount: ${summary.metrics.impactNoteCount}
- impactNoteEffect: ${summary.metrics.impactNoteEffect ?? "n/a"}
- impactNoteLanguage: ${summary.metrics.impactNoteLanguage ?? "n/a"}
- impactNoteSourceCount: ${summary.metrics.impactNoteSourceCount}
- impactNoteSourceLabels: ${summary.metrics.impactNoteSourceLabels.join(" | ") || "none"}
- impactNoteSummaryObjectiveOk: ${markdownBool(summary.metrics.impactNoteSummaryObjectiveOk)}
- impactNoteMetadataFree: ${markdownBool(summary.metrics.impactNoteMetadataFree)}
- impactNoteSourceAuthorityOk: ${markdownBool(summary.metrics.impactNoteSourceAuthorityOk)}
- impactNoteOutsideBlockingAsk: ${markdownBool(summary.metrics.impactNoteOutsideBlockingAsk)}
- impactNoteVisibleUrlsCredentialFree: ${markdownBool(summary.metrics.impactNoteVisibleUrlsCredentialFree)}
- helpSucceeded: ${markdownBool(summary.metrics.helpSucceeded)}
- selectionSucceeded: ${markdownBool(summary.metrics.selectionSucceeded)}
- readRouteCalls: ${summary.metrics.readRouteCalls}
- readRouteSucceeded: ${markdownBool(summary.metrics.readRouteSucceeded)}
- readActivationCalls: ${summary.metrics.readActivationCalls}
- legacyReadActivationCalls: ${summary.metrics.legacyReadActivationCalls}
- readActivationSucceeded: ${markdownBool(summary.metrics.readActivationSucceeded)}
- byoReadSequenceOk: ${markdownBool(summary.metrics.byoReadSequenceOk)}
- byoSelectorsNoPull: ${markdownBool(summary.metrics.byoSelectorsNoPull)}
- byoSnapshotDetached: ${markdownBool(summary.metrics.byoSnapshotDetached)}
- byoSnapshotExactHeadConsistent: ${markdownBool(summary.metrics.byoSnapshotExactHeadConsistent)}
- managedFinalTransportOk: ${markdownBool(summary.metrics.managedFinalTransportOk)}
- modelFirstTreeCommandsOk: ${markdownBool(summary.metrics.modelFirstTreeCommandsOk)}
- firstTreeCalls: ${summary.metrics.firstTreeCalls}
- runnerExitCode: ${summary.metrics.runnerExitCode === null ? "n/a" : summary.metrics.runnerExitCode}
- turns: ${summary.turns ?? "n/a"}
- firstResponseLatencyMs: ${summary.firstResponseLatencyMs ?? "n/a"}
- gradingJsonPath: \`${summary.gradingJsonPath}\`

## Grading

${gradingMarkdownRows(summary.grading)}

## Prompt

\`\`\`text
${summary.prompt}
\`\`\`

## Fixture Validation

${validationRows(summary.fixtureValidation)}

## Expected Fact Hits

${expectedFactRows(summary.metrics)}

## first-tree Command Results

${commandResultRows(summary.metrics)}
${drift}
## Paths

- runRoot: \`${summary.runRoot}\`
- workspacePath: \`${summary.workspacePath}\`
`;

  writeFileSync(summary.summaryMdPath, markdown, "utf8");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

export function formatSummaryTable(batch: BatchSummary): string {
  const rows = batch.cases.map((summary) => [
    summary.caseId,
    String(summary.expectedTrigger),
    String(summary.metrics.skillHit),
    String(summary.metrics.firstTreeCalls),
    String(summary.metrics.skillFileReadObserved),
    String(summary.metrics.expectedFactsObserved),
    String(summary.metrics.impactNoteBehaviorOk),
    String(summary.metrics.helpSucceeded),
    String(summary.metrics.selectionSucceeded),
    String(summary.metrics.modelFirstTreeCommandsOk),
    String(summary.passed),
  ]);
  const header = [
    "case_id",
    "expected_trigger",
    "skill_hit",
    "first_tree_calls",
    "skill_file_read",
    "expected_facts_observed",
    "impact_note_behavior_ok",
    "helpSucceeded",
    "selectionSucceeded",
    "modelFirstTreeCommandsOk",
    "passed",
  ];
  const widths = header.map((label, index) => {
    let width = label.length;
    for (const row of rows) {
      const value = row[index];
      if (value && value.length > width) width = value.length;
    }
    return width;
  });

  const lines = [
    header.map((label, index) => pad(label, widths[index] ?? label.length)).join("  "),
    ...rows.map((row) => row.map((value, index) => pad(value, widths[index] ?? value.length)).join("  ")),
  ];

  return lines.join("\n");
}

export function buildBatchSummary(cases: readonly CaseRunSummary[], runStartedAt: string): BatchSummary {
  let passed = 0;
  for (const summary of cases) {
    if (summary.passed) passed += 1;
  }

  return {
    cases,
    failed: cases.length - passed,
    passed,
    runStartedAt,
  };
}
