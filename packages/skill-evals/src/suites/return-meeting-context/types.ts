import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { CommandResult } from "../../core/types.js";

export type MeetingFixtureMode = "progress-only" | "later-override" | "ai-notes" | "partial-source";
export type MeetingPacketStatus = "no-change" | "needs-confirmation" | "ready-for-write" | "blocked-source";
export type MeetingSettlementExpectation = "none" | "settled" | "uncertain";

export type ReturnMeetingContextEvalCase = {
  briefingMode: "generated-fixture";
  expected: {
    candidateCount: number;
    forbiddenClaimTerms: readonly string[];
    handoff: "none" | "first-tree-write";
    requiredClaimTerms: readonly string[];
    settlement: MeetingSettlementExpectation;
    status: MeetingPacketStatus;
  };
  fixture: {
    mode: MeetingFixtureMode;
  };
  id: string;
  prompt: string;
  provider: "codex";
  skill: "return-meeting-context";
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

export type EvalMetrics = {
  candidateCountObserved: boolean;
  chronologyObserved: boolean;
  contextTreeCreated: boolean;
  finalResponse: string;
  forbiddenClaimTerms: readonly string[];
  handoffObserved: boolean;
  packetExists: boolean;
  packetText: string;
  requiredClaimTermsObserved: boolean;
  runnerExitCode: number;
  settlementObserved: boolean;
  skillFileReadObserved: boolean;
  sourceRepoChanged: boolean;
  statusObserved: boolean;
  validatorResult: CommandResult;
  validatorSucceeded: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedAction: MeetingPacketStatus;
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
