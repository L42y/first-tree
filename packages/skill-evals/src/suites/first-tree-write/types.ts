import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { CommandResult } from "../../core/types.js";

export type SourceArtifactKind = "absent" | "durable-decision-note" | "implementation-only-diff";
export type TreeState = "populated" | "unbound" | "unresolved";
export type TreeDiffExpectation = "none" | "minimal";
export type ExpectedAction =
  | "refuse_without_source"
  | "write_minimal_tree_diff"
  | "refuse_implementation_only_source"
  | "skip_tree_write_unbound"
  | "report_unbound_tree_write_gap"
  | "skip_tree_write_unresolved"
  | "report_unresolved_tree_write_gap";

export type FirstTreeWriteFixture = {
  sourceArtifact: SourceArtifactKind;
  treeState: TreeState;
};

export type FirstTreeWriteExpected = {
  action: ExpectedAction;
  requiredDiffSnippets?: readonly string[];
  requireVerify: boolean;
  responseHints: readonly string[];
  treeDiff: TreeDiffExpectation;
};

export type FirstTreeWriteForbidden = {
  content: readonly string[];
  sideEffects: readonly string[];
};

export type FirstTreeWriteEvalCase = {
  briefingMode: "minimal";
  expected: FirstTreeWriteExpected;
  fixture: FirstTreeWriteFixture;
  forbidden: FirstTreeWriteForbidden;
  id: string;
  prompt: string;
  provider: "codex";
  skill: "first-tree-write";
  status: "implemented";
  tags: readonly string[];
  tier: "gate";
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

export type FixtureValidation = {
  errors: readonly string[];
  ok: boolean;
  requiredFilesOk: boolean;
  verifyResult: CommandResult | null;
};

export type TreeStateSnapshot = {
  diff: string;
  status: string;
};

export type EvalMetrics = {
  expectedDiffSnippetsObserved: boolean;
  expectedResponseObserved: boolean;
  finalResponse: string;
  firstTreeArgv: readonly (readonly string[])[];
  firstTreeCommandResults: readonly {
    argv: readonly string[];
    exitCode: number;
  }[];
  fixtureValidationOk: boolean;
  forbiddenContentHits: readonly string[];
  modelVerifySucceeded: boolean;
  postModelVerifyResult: CommandResult | null;
  postModelVerifySucceeded: boolean | null;
  runnerExitCode: number | null;
  skillFileReadObserved: boolean;
  sourceRepoChanged: boolean;
  treeChanged: boolean;
  treeCliInvocationCount: number;
  treeDiff: string;
  treeSetupGuidanceObserved: boolean;
  treeSetupSurfaceGuidanceObserved: boolean;
  treeStatus: string;
  /** Final response proactively mentioned the Tree's absence; only the explicit Tree-write branch may state it. */
  unboundAbsenceMentionObserved: boolean;
  unboundGapStatementObserved: boolean;
  unboundSetupSteeringObserved: boolean;
  unboundTreeArtifactsCreated: boolean;
  /** The run read or referenced the stale `.first-tree/workspace.json` manifest or `context-tree/` checkout. */
  staleTreeArtifactAccessObserved: boolean;
  /** Final response states the unresolved gap: this write cannot complete right now because the binding could not be confirmed. */
  unresolvedGapStatementObserved: boolean;
  /** Final response mentioned the unconfirmed binding outside the explicit unresolved Tree-write gap statement. */
  unresolvedBindingMentionObserved: boolean;
  verifySucceeded: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: ExpectedAction;
  firstResponseLatencyMs: number | null;
  fixtureValidation: FixtureValidation;
  grading: SkillCaseGrading;
  gradingJsonPath: string;
  metrics: EvalMetrics;
  passed: boolean;
  prompt: string;
  runRoot: string;
  startedAt: string;
  summaryJsonPath: string;
  summaryMdPath: string;
  turns: number | null;
  workspacePath: string;
};

export type BatchSummary = {
  cases: readonly CaseRunSummary[];
  failed: number;
  passed: number;
  runStartedAt: string;
};
