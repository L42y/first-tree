import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";

export const QA_SURFACES = ["cli", "web"] as const;
export const QA_CAPABILITIES = ["build", "run", "drive", "observe", "measure", "reset"] as const;
export const QA_TIERS = ["test-only", "focused-local", "full-isolated"] as const;

export type QaSurface = (typeof QA_SURFACES)[number];
export type QaCapability = (typeof QA_CAPABILITIES)[number];
export type QaTier = (typeof QA_TIERS)[number];
export type QaFixtureMode = "focused-local" | "readiness-blocked" | "ready" | "test-only";
export type QaExpectedStatus = "BLOCKED" | "PASS";

export type FirstTreeQaEvalCase = {
  briefingMode: "generated-fixture";
  expected: {
    disposition: "no-change";
    planShouldExist: boolean;
    status: QaExpectedStatus;
    taskShouldRun: boolean;
    tier: QaTier;
  };
  fixture: {
    mode: QaFixtureMode;
  };
  id: string;
  prompt: string;
  provider: "codex";
  skill: "first-tree-qa";
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
};

export type ProductEvent = {
  at: number;
  capability?: QaCapability;
  durationMs?: number;
  kind:
    | "capability_failed"
    | "capability_ok"
    | "environment_inspected"
    | "environment_reused"
    | "infrastructure_retained"
    | "lease_released"
    | "shared_inspected"
    | "shared_mutated"
    | "task_ok"
    | "task_state_reset"
    | "test_ok";
  surface?: QaSurface;
  task?: string;
};

export type EvalMetrics = {
  attemptedCapabilities: readonly string[];
  dispositionObserved: boolean;
  environmentBaselineObserved: boolean;
  environmentFinalizedAfterUse: boolean;
  environmentLifecycleComplete: boolean;
  environmentLifecycleReported: boolean;
  environmentPreparedBeforeUse: boolean;
  evidenceObserved: boolean;
  expectedTierObserved: boolean;
  expectedStatusObserved: boolean;
  failedCapabilities: readonly string[];
  finalResponse: string;
  fixtureValidationOk: boolean;
  fullIsolationCommandObserved: boolean;
  infrastructureRetained: boolean;
  leaseReleased: boolean;
  performanceObserved: boolean;
  planAfterReadiness: boolean;
  planAfterTierReadiness: boolean;
  planExists: boolean;
  productEvidenceObserved: boolean;
  readinessComplete: boolean;
  reportExists: boolean;
  reportText: string;
  runContextExists: boolean;
  runnerExitCode: number | null;
  scopeLimitObserved: boolean;
  sharedInspectionBeforeUse: boolean;
  sharedStateInspected: boolean;
  sharedStateMutated: boolean;
  skillFileReadObserved: boolean;
  sourceRepoChanged: boolean;
  successfulCapabilities: readonly string[];
  taskAfterPlan: boolean;
  taskRan: boolean;
  taskStateReset: boolean;
  testRan: boolean;
  tierCapabilitiesComplete: boolean;
  tierRationaleObserved: boolean;
  unexpectedCapabilities: readonly string[];
  warmEnvironmentReused: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: QaExpectedStatus;
  expectedTier: QaTier;
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
