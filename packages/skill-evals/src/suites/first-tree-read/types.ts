import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { CommandResult } from "../../core/types.js";

export type WorkspaceKind = "blank" | "byo-context-tree" | "context-tree" | "unbound-managed" | "unresolved-managed";
export type BriefingMode = "minimal" | "runtime-generated";
export type ReadMode = "byo" | "managed";
export type ManagedTransport = "ask" | "send";

export type ImpactNoteEffect = "conflicted" | "confirmed" | "constrained" | "redirected";
export type ImpactNoteLanguage = "en" | "zh";

export type ImpactNoteExpectation =
  | { mode: "absent" }
  | {
      effect: ImpactNoteEffect;
      language: ImpactNoteLanguage;
      mode: "present";
      requiredSourceLabels?: readonly string[];
      sourceAuthority: {
        allowedNodePaths: readonly string[];
        exactCommit?: string;
        repository: string;
      };
      sourceCount: { max: number; min: number };
      summaryConcepts?: readonly (readonly string[])[];
      summaryForbidden?: readonly string[];
    };

export type FirstTreeReadEvalCase = {
  briefingMode?: BriefingMode;
  description: string;
  expectedFacts: readonly string[];
  expectedTrigger: boolean;
  id: string;
  impactNote: ImpactNoteExpectation;
  managedTransport: ManagedTransport | null;
  prompt: string;
  promptAlternates: readonly string[];
  readMode: ReadMode;
  /**
   * Managed workspace whose briefing explicitly states no bound Tree: the task
   * must continue from local inputs with zero Tree CLI invocations and no Tree
   * setup/binding wording, instead of triggering a read.
   */
  unboundContinuation?: boolean;
  /**
   * Managed unbound workspace where the user explicitly asks for a Context Tree
   * read: the agent must state only that this read cannot be completed because
   * nothing is bound, with zero Tree CLI invocations, no manifest/Tree
   * creation, and no bind/create/setup/install guidance.
   */
  unboundExplicitRead?: boolean;
  /**
   * Managed workspace whose briefing states the binding could not be confirmed
   * while the last-known manifest and Tree checkout remain on disk: the task
   * must continue from local inputs with zero Tree CLI invocations, no skill
   * routing, and zero reads of the stale manifest or checkout.
   */
  unresolvedContinuation?: boolean;
  /**
   * Managed unresolved-binding workspace where the user explicitly asks for a
   * Context Tree read: the agent must state only that this read cannot be
   * completed right now because the binding could not be confirmed — never
   * claiming that no Tree is bound — with zero Tree CLI invocations, zero
   * stale-manifest/checkout reads, and no setup steering.
   */
  unresolvedExplicitRead?: boolean;
  workspaceKind: WorkspaceKind;
};

export type FixtureValidation = {
  domainNodeCount: number;
  errors: readonly string[];
  minDepthOk: boolean;
  ok: boolean;
  requiredFilesOk: boolean;
  verifyResult: CommandResult | null;
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

export type EvalMetrics = {
  expectedFactHits: readonly string[];
  expectedFactsObserved: boolean;
  firstTreeArgv: readonly (readonly string[])[];
  firstTreeCalls: number;
  firstTreeCommandResults: readonly {
    argv: readonly string[];
    exitCode: number;
  }[];
  fixtureValidationOk: boolean;
  helpAttempted: boolean;
  helpCalls: number;
  helpExitCodes: readonly number[];
  helpSucceeded: boolean;
  impactNoteBehaviorOk: boolean;
  impactNoteBlankLineBefore: boolean;
  impactNoteCount: number;
  impactNoteEffect: string | null;
  impactNoteAtFinalEnd: boolean;
  impactNoteExactLinksOk: boolean;
  impactNoteLanguage: ImpactNoteLanguage | null;
  impactNoteLogicalLinesOk: boolean;
  impactNoteMetadataFree: boolean;
  impactNoteOutsideBlockingAsk: boolean;
  impactNoteSourceAuthorityOk: boolean;
  impactNoteSourceCount: number;
  impactNoteSourceLabels: readonly string[];
  impactNoteSummaryConceptsOk: boolean;
  impactNoteSummaryForbiddenOk: boolean;
  impactNoteSummaryObjectiveOk: boolean;
  impactNoteVisibleUrlsCredentialFree: boolean;
  byoReadSequenceOk: boolean;
  byoSelectorsNoPull: boolean;
  byoSnapshotDetached: boolean;
  byoSnapshotExactHeadConsistent: boolean;
  managedFinalTransportOk: boolean;
  /** The delivery actually used by the last successful authoring call. */
  managedFinalTransportKind: ManagedTransport | null;
  /** The delivery this case's task contract requires, when it declares one. */
  managedTransportExpected: ManagedTransport | null;
  treeCliInvocationCount: number;
  treeSetupWordingObserved: boolean;
  /** Visible output steers the user at a setup surface (Settings, web console, operator/admin, Tree configuration). */
  treeSetupSurfaceGuidanceObserved: boolean;
  /** Delivered output proactively mentioned the Tree's absence; only the explicit Tree-read branch may state it. */
  unboundAbsenceMentionObserved: boolean;
  /** Visible output states the specific gap: this Tree read cannot complete because nothing is bound. */
  unboundGapStatementObserved: boolean;
  /** Delivered output for an explicit Tree read carried any setup/recovery steering. */
  unboundSetupSteeringObserved: boolean;
  /** An unbound run created `.first-tree/workspace.json` or a `context-tree/` checkout. */
  unboundTreeArtifactsCreated: boolean;
  /** The run read or referenced the stale `.first-tree/workspace.json` manifest or `context-tree/` checkout. */
  staleTreeArtifactAccessObserved: boolean;
  /** Delivered output states the unresolved gap: this read cannot complete right now because the binding could not be confirmed. */
  unresolvedGapStatementObserved: boolean;
  /** Delivered output mentioned the unconfirmed binding outside the explicit unresolved Tree-read gap statement. */
  unresolvedBindingMentionObserved: boolean;
  legacyReadActivationCalls: number;
  modelFirstTreeCommandsOk: boolean;
  readActivationCalls: number;
  readActivationSucceeded: boolean;
  readRouteCalls: number;
  readRouteSucceeded: boolean;
  runnerExitCode: number | null;
  selectionSucceeded: boolean;
  skillFileReadObserved: boolean;
  skillHit: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedTrigger: boolean;
  firstResponseLatencyMs: number | null;
  fixtureValidation: FixtureValidation;
  grading: SkillCaseGrading;
  gradingJsonPath: string;
  metrics: EvalMetrics;
  passed: boolean;
  prompt: string;
  readMode: ReadMode;
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
