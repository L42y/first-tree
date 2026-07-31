import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";

export type AuditScenario =
  | "decision-lock"
  | "mechanical"
  | "no-binding"
  | "report-only"
  | "stale-before-write"
  | "stale-before-publish"
  | "strong-local"
  | "weak-cross-domain";

export type AuditForge = "github" | "gitlab";

export type AuditExpectedAction = "fail-closed" | "focused-review-request" | "human-ask" | "issue-or-ask" | "report";

export type ContextTreeAuditEvalCase = {
  briefingMode: "minimal";
  expected: {
    action: AuditExpectedAction;
    diffPaths: readonly string[];
    verifyExitCode: number | null;
    writeSkillRequired: boolean;
  };
  fixture: {
    bindingBranch: string;
    forge: AuditForge;
    mode: "maintenance" | "report-only";
    scenario: AuditScenario;
  };
  id: string;
  prompt: string;
  provider: "codex";
  skill: "context-tree-audit";
  status: "implemented";
  tags: readonly string[];
  tier: "gate";
};

export type AuditFixtureExpectation = {
  advancedHeadOid: string | null;
  auditWorktreePath: string | null;
  bindingBranch: string;
  expectedAction: AuditExpectedAction;
  expectedDiffPaths: readonly string[];
  expectedFinding: {
    claimTokens: readonly string[];
    evidenceTokens: readonly string[];
    policyTokens: readonly string[];
  } | null;
  forgeDefaultBranch: string;
  headOid: string | null;
  forge: AuditForge;
  mode: "maintenance" | "report-only";
  originPath: string | null;
  repo: string;
  scenario: AuditScenario;
  scope: string;
  workspacePath: string;
};

export type AuditFixtureIntegrity = {
  auditWorktreeCleaned: boolean;
  boundHeadUnchanged: boolean;
  boundWorktreeClean: boolean;
  noGuessedTreeState: boolean;
  originBranchExpected: boolean;
  unpublishedAuthoringStateClean: boolean;
};

export type AuditFixtureState = AuditFixtureIntegrity & {
  changedBranchCount: number;
  diffPaths: readonly string[];
  expectedContentObserved: boolean;
};

export type AuditReviewArtifact = "pull-request" | "merge-request";
export type AuditArtifact = "human-ask" | "issue" | AuditReviewArtifact;

export type AuditEvalMetrics = {
  artifactCount: number;
  artifacts: readonly AuditArtifact[];
  blockedExternalAttempts: number;
  expectedActionObserved: boolean;
  evidenceOrderValid: boolean;
  artifactPayloadsValid: boolean;
  firstTreeReadLoaded: boolean;
  fixtureState: AuditFixtureState;
  helpObserved: boolean;
  runnerExitCode: number | null;
  selectorObserved: boolean;
  selectorBoundToSnapshot: boolean;
  snapshotBranchProvenanceValid: boolean;
  snapshotFetchObserved: boolean;
  snapshotRefResolved: boolean;
  snapshotWorktreeAdded: boolean;
  semanticReadAfterVerify: boolean;
  semanticReadBeforeVerify: boolean;
  selfReviewOrMergeAttempted: boolean;
  skillFileReadObserved: boolean;
  siblingEvidenceReadObserved: boolean;
  sourceEvidenceReadObserved: boolean;
  verifyBoundToSnapshot: boolean;
  verifyExitCodes: readonly number[];
  writeSkillReadObserved: boolean;
  writeFreshnessChecked: boolean;
  publicationFreshnessChecked: boolean;
  draftReviewRequestObserved: boolean;
  reviewRequestFollowObserved: boolean;
  providerIsolationValid: boolean;
};

export type CliOptions = {
  caseId: string | null;
  claudeBin: string;
  codexBin: string;
  json: boolean;
  model: string | null;
  provider: AgentProviderName;
  verbose: boolean;
};

export type AuditCaseRunSummary = {
  bindingBranch: string;
  caseId: string;
  driftNote: string | null;
  expectedAction: AuditExpectedAction;
  forge: AuditForge;
  firstResponseLatencyMs: number | null;
  grading: SkillCaseGrading;
  gradingJsonPath: string;
  metrics: AuditEvalMetrics;
  passed: boolean;
  prompt: string;
  runRoot: string;
  startedAt: string;
  summaryJsonPath: string;
  summaryMdPath: string;
  turns: number | null;
  workspacePath: string;
};

export type AuditBatchSummary = {
  cases: readonly AuditCaseRunSummary[];
  failed: number;
  passed: number;
  runStartedAt: string;
};
