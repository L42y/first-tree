import type { AgentProviderName } from "../../core/provider/types.js";
import type { CommandResult } from "../../core/types.js";

export type MeetingFixtureMode = "six-categories" | "later-override" | "ai-only" | "partial-source";
export type MeetingPacketStatus = "complete" | "needs-confirmation" | "blocked-source";
export type MeetingSettlementExpectation = "confirmed" | "uncertain" | "none";

export type MeetingRecordsEvalCase = {
  expected: {
    categories: readonly string[];
    forbiddenTerms: readonly string[];
    itemCount: number;
    rawCanaries: readonly string[];
    requiredTerms: readonly string[];
    settlement: MeetingSettlementExpectation;
    status: MeetingPacketStatus;
  };
  fixture: {
    mode: MeetingFixtureMode;
  };
  id: string;
  prompt: string;
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

export type PacketEvaluation = {
  categoriesObserved: boolean;
  chronologyObserved: boolean;
  forbiddenTerms: readonly string[];
  itemCountObserved: boolean;
  rawCanaries: readonly string[];
  requiredTermsObserved: boolean;
  settlementObserved: boolean;
  statusObserved: boolean;
};

export type EvalMetrics = PacketEvaluation & {
  contextTreeCreated: boolean;
  finalResponse: string;
  packetExists: boolean;
  packetText: string;
  runnerExitCode: number;
  skillFileReadObserved: boolean;
  sourceRepoChanged: boolean;
  validatorResult: CommandResult;
  validatorSucceeded: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  fixtureValidation: FixtureValidation;
  metrics: EvalMetrics;
  passed: boolean;
  prompt: string;
  runRoot: string;
  startedAt: string;
  summaryJsonPath: string;
  summaryMdPath: string;
  workspacePath: string;
};

export type BatchSummary = {
  cases: readonly CaseRunSummary[];
  failed: number;
  passed: number;
  runStartedAt: string;
};
