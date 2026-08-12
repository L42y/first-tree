import {
  CONTEXT_IMPACT_NOTE_EFFECT_LABELS,
  type ContextImpactNote,
  parseContextImpactNotes,
  parseExactContextSourceLink,
} from "@first-tree/shared";

import { findStringValue, isRecord, isStringArray } from "../../core/events.js";
import { treeArtifactBaselineViolation } from "./fixture.js";
import type {
  EvalMetrics,
  FixtureValidation,
  ImpactNoteExpectation,
  ManagedTransport,
  ReadMode,
  TreeArtifactBaseline,
} from "./types.js";

const HELP_ARGV = ["tree", "tree", "--help"];
const TEXT_KEYS = ["content", "message", "output_text", "text"];

type FactMatcher = {
  all: readonly RegExp[];
  fact: string;
};

const FACT_MATCHERS: readonly FactMatcher[] = [
  {
    all: [
      /user\s+jwt/iu,
      /((?:unified(?:\s+user\s+jwt)?|single)\s+authorization surface|single authorization model|统一[^。\n]*授权|统一[^。\n]*身份模型)/iu,
    ],
    fact: "User JWT auth is the unified authorization surface.",
  },
  {
    all: [
      /(route scopes?|scope rules?|scopes?)/iu,
      /(live organization membership|live org(?:anization)? membership|当前[^。\n]*membership|membership checks?)/iu,
    ],
    fact: "Route scopes must be checked against live organization membership before cross-org actions.",
  },
  {
    all: [
      /(http[^。\n]*routes?|auth[^。\n]*routes?|multi-org|jwt auth)/iu,
      /(docs\/development\/http-path-conventions\.md|path conventions?|路径约定)/iu,
    ],
    fact: "HTTP routes must follow the repo path conventions document before auth or multi-org changes.",
  },
  {
    all: [/(top-level|顶层)/iu, /(systems?|系统)/iu, /(domains?|领域)/iu, /(operations?|运维|操作)/iu],
    fact: "Top-level Context Tree domains are systems, domains, and operations.",
  },
  {
    all: [
      /(production release|生产发布|正式发布)/iu,
      /(security[- ]audit|安全审计)/iu,
      /(before deployment|发布前|部署前)/iu,
    ],
    fact: "Production releases require completed security-audit approval before deployment.",
  },
  {
    all: [
      /(production rollout|生产发布|正式发布)/iu,
      /(single reviewable scope|统一[^。\n]*审查范围|单一[^。\n]*范围)/iu,
    ],
    fact: "Every production rollout must keep a single reviewable scope across release and billing policy.",
  },
  {
    all: [/(billing changes?|计费变更)/iu, /(core release|核心版本|核心发布)/iu, /(stable monitoring|稳定监控)/iu],
    fact: "Billing changes must roll out after the core release reaches stable monitoring.",
  },
  {
    all: [/inbox|delivery/iu, /deduplicat/iu, /client[- ](boundary|side)/iu],
    fact: "Inbox delivery is deduplicated at the client boundary.",
  },
  {
    all: [/refresh tokens?/iu, /rotat/iu, /replay/iu],
    fact: "Refresh tokens rotate on every use to limit replay.",
  },
];

/**
 * A note the model wrote, plus the two judgements only this grader makes:
 * whether the impact sentence stays objective, and which visible surface
 * carried it. Everything else comes from the shared parser the Server reads
 * notes with, so a format the eval blesses is a format the Server can store.
 */
type ImpactNoteObservation = ContextImpactNote & {
  sourceLabels: readonly string[];
  sourceUrls: readonly string[];
  summaryObjectiveOk: boolean;
  textIndex: number;
};

/**
 * Canonical `host/path` for a repository the FIXTURE declares, which may be an
 * https or scp-like ssh URL. Distinct from the shared link parser, which
 * canonicalizes a forge blob URL the MODEL wrote.
 */
function canonicalRepositoryIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
    return path.length > 0 ? `${url.host.toLowerCase()}/${path.toLowerCase()}` : null;
  } catch {
    const scpMatch = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/u.exec(value.trim());
    if (!scpMatch) return null;
    const host = scpMatch[1]?.toLowerCase() ?? "";
    const path = (scpMatch[2] ?? "")
      .replace(/^\/+|\/+$/gu, "")
      .replace(/\.git$/iu, "")
      .toLowerCase();
    return host.length > 0 && path.length > 0 ? `${host}/${path}` : null;
  }
}

function isObjectiveImpactSummary(summary: string): boolean {
  const hasEnglishFirstPerson =
    /\b(?:we|We|our|Our|my|My|me|Me|us|Us|ours|Ours|mine|Mine)\b(?!-)/u.test(summary) ||
    /(?<!\bphase )\bi\b(?![/-])/iu.test(summary);
  const hasFirstPerson =
    hasEnglishFirstPerson ||
    /我们|我的|(^|[\s，。！？，；：])我(?=[\s，。！？，；：]|使用|读取|参考|认为|选择|决定)/u.test(summary);
  const withoutAbbreviationPeriods = summary.replace(/\b(?:[A-Za-z]\.){2,}/gu, (value) => value.replaceAll(".", ""));
  const hasMultipleSentences = /(?:[!?。！？]\s*|\.\s+)[*_`"'“‘([]*\S/u.test(withoutAbbreviationPeriods);
  return !hasFirstPerson && !hasMultipleSentences;
}

function parseImpactNotes(texts: readonly string[]): readonly ImpactNoteObservation[] {
  const observations: ImpactNoteObservation[] = [];
  for (const [textIndex, text] of texts.entries()) {
    for (const note of parseContextImpactNotes(text)) {
      observations.push({
        ...note,
        sourceLabels: note.sources.map((source) => source.label),
        sourceUrls: note.sources.map((source) => source.url),
        summaryObjectiveOk: isObjectiveImpactSummary(note.summary),
        textIndex,
      });
    }
  }
  return observations;
}

function visibleUrlsCredentialFree(texts: readonly string[]): boolean {
  const urls = texts
    .flatMap((text) => [...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>\])]+/giu)].map((match) => match[0] ?? ""))
    .filter(Boolean);

  return urls.every((value) => {
    try {
      const url = new URL(value);
      // SSH commonly carries the transport identity as `git@host`; that
      // username is part of the repository contract, not a credential.
      return url.password === "" && (url.protocol === "ssh:" || url.username === "");
    } catch {
      return false;
    }
  });
}

function sourceAuthorityMatches(
  observation: ImpactNoteObservation | null,
  expectation: ImpactNoteExpectation,
  selectedExactCommit: string | null,
): boolean {
  if (expectation.mode === "absent") return true;
  if (observation === null) return false;

  const expectedRepository = canonicalRepositoryIdentity(expectation.sourceAuthority.repository);
  const expectedCommit = (expectation.sourceAuthority.exactCommit ?? selectedExactCommit)?.toLowerCase() ?? null;
  const allowedPaths = new Set(expectation.sourceAuthority.allowedNodePaths);
  if (expectedRepository === null || expectedCommit === null) return false;

  return observation.sourceUrls.every((value) => {
    const source = parseExactContextSourceLink(value);
    return (
      source !== null &&
      source.repositoryIdentity === expectedRepository &&
      source.commit === expectedCommit &&
      allowedPaths.has(source.nodePath)
    );
  });
}

function includesAny(value: string, alternatives: readonly string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return alternatives.some((alternative) => normalized.includes(alternative.toLocaleLowerCase()));
}

function deriveImpactNoteMetrics(
  texts: readonly string[],
  expectation: ImpactNoteExpectation,
  options: {
    contextDecisionMetadataPresent: boolean;
    selectedExactCommit: string | null;
    visibleOutputKinds?: readonly (ManagedTransport | null)[];
  },
) {
  const observations = parseImpactNotes(texts);
  const observation = observations[0] ?? null;
  const allText = texts.join("\n");
  const metadataFree =
    !options.contextDecisionMetadataPresent &&
    !/contextDecision|["']effect["']\s*:|["']evidence["']\s*:/u.test(allText);
  const atFinalEnd = observation?.atEnd === true && observation.textIndex === texts.length - 1;
  // A blocking question asks the reader to choose; an attribution footnote there
  // competes with the choice instead of serving it.
  const noteOutsideBlockingAsk = observations.every((item) => options.visibleOutputKinds?.[item.textIndex] !== "ask");
  const sourceAuthorityOk = sourceAuthorityMatches(observation, expectation, options.selectedExactCommit);
  const visibleUrlsSafe = visibleUrlsCredentialFree(texts);
  const summaryConceptsOk =
    expectation.mode === "absent" ||
    (expectation.summaryConcepts?.every((alternatives) => includesAny(observation?.summary ?? "", alternatives)) ??
      true);
  const summaryForbiddenOk =
    expectation.mode === "absent" ||
    !(expectation.summaryForbidden?.some((value) => includesAny(observation?.summary ?? "", [value])) ?? false);
  const requiredSourceLabelsOk =
    expectation.mode === "absent" ||
    (expectation.requiredSourceLabels?.every((label) => observation?.sourceLabels.includes(label)) ?? true);
  const sourceCountOk =
    expectation.mode === "absent" ||
    ((observation?.sourceLabels.length ?? 0) >= expectation.sourceCount.min &&
      (observation?.sourceLabels.length ?? 0) <= expectation.sourceCount.max);
  const expectedEffectLabel =
    expectation.mode === "present" ? CONTEXT_IMPACT_NOTE_EFFECT_LABELS[expectation.language][expectation.effect] : null;
  const behaviorOk =
    expectation.mode === "absent"
      ? observations.length === 0 && metadataFree && noteOutsideBlockingAsk
      : observations.length === 1 &&
        observation !== null &&
        atFinalEnd &&
        observation.blankLineBefore &&
        observation.logicalLinesOk &&
        observation.sourceScaffoldingOk &&
        observation.summaryObjectiveOk &&
        observation.exactLinksOk &&
        noteOutsideBlockingAsk &&
        sourceAuthorityOk &&
        observation.language === expectation.language &&
        observation.effectLabel === expectedEffectLabel &&
        sourceCountOk &&
        requiredSourceLabelsOk &&
        summaryConceptsOk &&
        summaryForbiddenOk &&
        metadataFree &&
        visibleUrlsSafe;

  return {
    impactNoteBehaviorOk: behaviorOk,
    impactNoteAtFinalEnd: atFinalEnd,
    impactNoteBlankLineBefore: observation?.blankLineBefore ?? false,
    impactNoteCount: observations.length,
    impactNoteEffect: observation?.effectLabel ?? null,
    impactNoteExactLinksOk: observation?.exactLinksOk ?? false,
    impactNoteLanguage: observation?.language ?? null,
    impactNoteLogicalLinesOk: observation?.logicalLinesOk ?? false,
    impactNoteMetadataFree: metadataFree,
    impactNoteOutsideBlockingAsk: noteOutsideBlockingAsk,
    impactNoteSourceAuthorityOk: sourceAuthorityOk,
    impactNoteSourceCount: observation?.sourceLabels.length ?? 0,
    impactNoteSourceLabels: observation?.sourceLabels ?? [],
    impactNoteSummaryConceptsOk: summaryConceptsOk,
    impactNoteSummaryForbiddenOk: summaryForbiddenOk,
    impactNoteSummaryObjectiveOk: observation?.summaryObjectiveOk ?? false,
    impactNoteVisibleUrlsCredentialFree: visibleUrlsSafe,
  };
}

function argvEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function commandArgv(argv: readonly string[]): readonly string[] {
  return argv[0] === "--json" ? argv.slice(1) : argv;
}

function isHelpArgv(argv: readonly string[]): boolean {
  return argvEquals(commandArgv(argv), HELP_ARGV);
}

function isReadRouteArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "context" && command[1] === "route";
}

function isReadActivationArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "context" && command[1] === "snapshot";
}

function isLegacyReadActivationArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "tree" && command[1] === "read" && !command.includes("--help") && !command.includes("-h");
}

function isTreeTreeArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "tree" && command[1] === "tree";
}

function isTreeOperationArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "tree" || command[0] === "context";
}

function isTreeSelectorArgv(argv: readonly string[]): boolean {
  return isTreeTreeArgv(argv) && !isHelpArgv(argv);
}

function isChatAuthoringArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "chat" && (command[1] === "send" || command[1] === "ask");
}

function isChatProgressArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "chat" && command[1] === "update";
}

function chatAuthoringKind(argv: readonly string[]): "ask" | "send" | null {
  const command = commandArgv(argv);
  return command[0] === "chat" && (command[1] === "ask" || command[1] === "send") ? command[1] : null;
}

function metadataOptionValues(argv: readonly string[]): readonly string[] {
  const command = commandArgv(argv);
  const values: string[] = [];
  for (let index = 2; index < command.length; index += 1) {
    const arg = command[index] ?? "";
    if (arg === "--metadata" || arg === "-m") {
      const value = command[index + 1];
      if (value !== undefined) values.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--metadata=") || arg.startsWith("-m=")) {
      values.push(arg.slice(arg.indexOf("=") + 1));
    }
  }
  return values;
}

function hasContextDecisionMetadata(argv: readonly string[]): boolean {
  return metadataOptionValues(argv).some((value) => {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) && Object.hasOwn(parsed, "contextDecision");
    } catch {
      return /["']?contextDecision["']?\s*:/u.test(value);
    }
  });
}

function isModelPhase(event: Record<string, unknown>): boolean {
  return event.phase === "model";
}

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function containsSkillFileRead(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;

  const nestedEvent = event.event;
  if (!findStringValue(nestedEvent, (value) => value.includes("first-tree-read/SKILL.md"))) {
    return false;
  }

  const serialized = JSON.stringify(nestedEvent) ?? "";
  if (serialized.includes("Available Skills")) return false;
  return /tool|exec|command|cmd|read|cat|sed/iu.test(serialized);
}

function isAssistantMessageRecord(record: Record<string, unknown>): boolean {
  const type = eventType(record);
  const role = typeof record.role === "string" ? record.role : null;

  if (type === "agent_message" || type === "assistant_message") return true;
  if (type === "message" && (role === null || role === "assistant")) return true;
  if (type === "output_text" || type === "response.output_text.done") return true;

  return false;
}

function collectTextValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectTextValue(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  for (const key of TEXT_KEYS) {
    const item = value[key];
    if (typeof item === "string") {
      texts.push(item);
    } else if (Array.isArray(item)) {
      texts.push(...collectTextValue(item));
    }
  }
  return texts;
}

function collectAssistantText(value: unknown): string[] {
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectAssistantText(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  if (isAssistantMessageRecord(value)) {
    texts.push(...collectTextValue(value));
  }

  const item = value.item;
  if (isRecord(item)) {
    texts.push(...collectAssistantText(item));
  }

  const message = value.message;
  if (isRecord(message)) {
    texts.push(...collectAssistantText(message));
  }

  const response = value.response;
  if (isRecord(response) || Array.isArray(response)) {
    texts.push(...collectAssistantText(response));
  }

  const output = value.output;
  if (Array.isArray(output)) {
    texts.push(...collectAssistantText(output));
  }

  return texts;
}

function collectModelOutputText(event: unknown): string[] {
  if (!isRecord(event)) return [];
  if (eventType(event) !== "codex_event") return [];
  return collectAssistantText(event.event);
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}

function expectedFactHits(modelOutputText: string, expectedFacts: readonly string[]): string[] {
  const normalizedOutput = normalizeForMatch(modelOutputText);
  const hits: string[] = [];

  for (const fact of uniqueStrings(expectedFacts)) {
    const normalizedFact = normalizeForMatch(fact);
    const factMatcher = FACT_MATCHERS.find((matcher) => matcher.fact === fact);
    const matchedByConcept = factMatcher?.all.every((pattern) => pattern.test(modelOutputText)) ?? false;
    const matchedByExactNormalized = normalizedFact.length > 0 && normalizedOutput.includes(normalizedFact);
    if (matchedByExactNormalized || matchedByConcept) {
      hits.push(fact);
    }
  }

  return hits;
}

/**
 * The one statement an explicit Tree read in an unbound workspace may make:
 * this read cannot complete because nothing is bound. A qualifying output must
 * express BOTH the blocked read AND the no-binding reason anchored to the
 * Tree — "cannot be completed right now" without the reason, or a reason
 * about something else ("the source repository is not bound"), does not
 * qualify. Bind/create/setup guidance is graded separately by
 * `treeSetupWordingObserved` and `treeSetupSurfaceGuidanceObserved`.
 */
const UNBOUND_REASON =
  /no\s+(?:context\s+)?tree\s+is\s+bound|no\s+bound\s+(?:context\s+)?tree|(?:context\s+)?tree\s+is\s+not\s+bound|no\s+(?:context\s+)?tree\s+binding|without\s+a\s+bound\s+(?:context\s+)?tree/iu;
const CANNOT_COMPLETE =
  /cannot\s+be\s+completed|can'?t\s+be\s+completed|cannot\s+complete|can'?t\s+complete|unable\s+to\s+complete|not\s+possible/iu;

function containsUnboundGapStatement(text: string): boolean {
  return /(?:context\s+)?tree/iu.test(text) && CANNOT_COMPLETE.test(text) && UNBOUND_REASON.test(text);
}

/**
 * Proactive missing-binding mention. An ordinary unbound task must stay
 * silent about the Tree's absence; only the explicit Tree-read branch may
 * state it, as part of the required gap statement.
 */
function containsUnboundAbsenceMention(text: string): boolean {
  return UNBOUND_REASON.test(text);
}

/**
 * The one statement an explicit Tree read in an unresolved-binding workspace
 * may make: this read cannot complete right now because the binding could not
 * be confirmed. A qualifying output must express BOTH the blocked read AND
 * the unconfirmed-binding reason — and must not claim that no Tree is bound,
 * which `containsUnboundAbsenceMention` catches separately.
 */
const UNRESOLVED_REASON =
  /binding\s+could\s+not\s+be\s+confirmed|could\s+not\s+confirm\s+the\s+(?:(?:context\s+)?tree\s+)?binding|(?:tree\s+)?binding\s+(?:was|is|remains)\s+(?:currently\s+)?unconfirmed|unconfirmed\s+(?:context\s+)?tree\s+binding/iu;

function containsUnresolvedGapStatement(text: string): boolean {
  return /(?:context\s+)?tree/iu.test(text) && CANNOT_COMPLETE.test(text) && UNRESOLVED_REASON.test(text);
}

/**
 * Proactive unconfirmed-binding mention. An ordinary unresolved-binding task
 * must stay silent about the binding state; only the explicit Tree-read
 * branch may state it, as part of the required gap statement.
 */
function containsUnresolvedBindingMention(text: string): boolean {
  return UNRESOLVED_REASON.test(text);
}

/**
 * Stale-artifact access: with an unresolved binding the last-known
 * `.first-tree/workspace.json` manifest and `context-tree/` checkout remain
 * on disk, but this session never confirmed them, so any tool-phase read or
 * reference of those paths fails the case. Model prose alone does not match:
 * the event must look like a tool/command interaction, mirroring the skill
 * file read detector.
 */
const STALE_TREE_ARTIFACT_PATH = /\.first-tree\/workspace\.json|context-tree\//iu;

function containsStaleTreeArtifactAccess(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;

  const nestedEvent = event.event;
  if (!findStringValue(nestedEvent, (value) => STALE_TREE_ARTIFACT_PATH.test(value))) {
    return false;
  }

  const serialized = JSON.stringify(nestedEvent) ?? "";
  if (serialized.includes("Available Skills")) return false;
  return /tool|exec|command|cmd|read|cat|sed/iu.test(serialized);
}

/**
 * Setup-surface steering: pointing the user at Settings, the web console, an
 * operator/admin, or Tree configuration as the way out of a missing binding.
 * A pure "no Tree is bound" gap statement must not match, and ordinary
 * business prose ("use the web console to export the report", "ask your admin
 * for billing access") must not match either: the web-console and
 * operator/admin alternatives fire only when Tree/binding/setup wording
 * appears nearby.
 */
function containsTreeSetupSurfaceGuidance(text: string): boolean {
  return (
    /\bsettings\b\s*(?:→|->|>|:)?[^.!?\n]{0,40}(?:context\s+)?tree\b/iu.test(text) ||
    /(?:context\s+)?tree\b[^.!?\n]{0,40}\bsettings\b/iu.test(text) ||
    /\bweb\s+console\b[^.!?\n]{0,60}(?:(?:context\s+)?tree|bind(?:ing)?|set\s*up|setup)\b/iu.test(text) ||
    /(?:(?:context\s+)?tree|bind(?:ing)?|set\s*up|setup)\b[^.!?\n]{0,60}\bweb\s+console\b/iu.test(text) ||
    /\bask\s+(?:an?|your)\s+(?:operator|admin|administrator)\b[^.!?\n]{0,60}(?:(?:context\s+)?tree|bind(?:ing)?|set\s*up|setup)\b/iu.test(
      text,
    ) ||
    /(?:(?:context\s+)?tree|bind(?:ing)?|set\s*up|setup)\b[^.!?\n]{0,60}\bask\s+(?:an?|your)\s+(?:operator|admin|administrator)\b/iu.test(
      text,
    ) ||
    /\bconfigure\s+(?:the\s+)?(?:context\s+)?tree\b/iu.test(text)
  );
}

/**
 * Strict setup/recovery steering check for the explicit Tree-read branch: the
 * delivered answer may contain only the gap statement, so ANY setup-surface
 * mention — Settings, the web console, an operator/admin, configuration, or
 * setup/install wording — fails, even when split across separate deliveries.
 * The ordinary unbound continuation branch intentionally does NOT use this
 * detector, so business prose mentioning an admin or settings stays safe.
 */
const UNBOUND_SETUP_STEERING =
  /\bsettings\b|\bweb\s+console\b|\boperators?\b|\badmin(?:istrator)?s?\b|\bconfigur(?:e|ation|ing)\b|\bset\s*up\b|\bsetup\b|\binstall(?:ing|ation)?\b/iu;

function containsUnboundSetupSteering(text: string): boolean {
  return UNBOUND_SETUP_STEERING.test(text);
}

export function deriveMetrics(
  events: readonly unknown[],
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
  expectedFacts: readonly string[],
  impactNoteExpectation: ImpactNoteExpectation = { mode: "absent" },
  managedTransportExpectation: ManagedTransport | null = null,
  options: {
    artifactBaseline?: TreeArtifactBaseline | null;
    unboundWorkspace?: boolean;
    unresolvedWorkspace?: boolean;
    workspacePath?: string;
  } = {},
): EvalMetrics {
  let firstTreeCalls = 0;
  let helpCalls = 0;
  let legacyReadActivationCalls = 0;
  let readActivationCalls = 0;
  let readRouteCalls = 0;
  let skillFileReadObserved = false;
  let staleTreeArtifactAccessObserved = false;
  const authoringCalls: Array<{
    argv: string[];
    body: string;
    contextDecisionMetadataPresent: boolean;
    exitCode: number | null;
  }> = [];
  const progressCalls: Array<{ argv: string[]; body: string; exitCode: number | null }> = [];
  const firstTreeArgv: string[][] = [];
  const firstTreeCommandResults: Array<{ argv: string[]; exitCode: number }> = [];
  const helpExitCodes: number[] = [];
  const modelOutputTexts: string[] = [];
  const readActivationResults: Array<{ exactCommit: string | null; exitCode: number }> = [];
  const readRouteExitCodes: number[] = [];
  const selectorSnapshotResults: Array<{ actualHead: string | null; detachedHead: boolean }> = [];

  for (const event of events) {
    if (containsSkillFileRead(event)) {
      skillFileReadObserved = true;
    }
    if (containsStaleTreeArtifactAccess(event)) {
      staleTreeArtifactAccessObserved = true;
    }

    modelOutputTexts.push(...uniqueStrings(collectModelOutputText(event)));

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_result") && isModelPhase(event)) {
      const argv = event.argv;
      if (!isStringArray(argv)) continue;

      if (type === "first_tree_call") {
        firstTreeCalls += 1;
        firstTreeArgv.push([...argv]);
        if (isChatAuthoringArgv(argv)) {
          authoringCalls.push({
            argv: [...argv],
            body: typeof event.body === "string" ? event.body : "",
            contextDecisionMetadataPresent: hasContextDecisionMetadata(argv),
            exitCode: null,
          });
        }
        if (isChatProgressArgv(argv)) {
          progressCalls.push({
            argv: [...argv],
            body: typeof event.body === "string" ? event.body : "",
            exitCode: null,
          });
        }
        if (isHelpArgv(argv)) {
          helpCalls += 1;
        }
        if (isReadActivationArgv(argv)) {
          readActivationCalls += 1;
        }
        if (isLegacyReadActivationArgv(argv)) {
          legacyReadActivationCalls += 1;
        }
        if (isReadRouteArgv(argv)) {
          readRouteCalls += 1;
        }
      }

      if (type === "first_tree_result" && typeof event.exitCode === "number") {
        firstTreeCommandResults.push({ argv: [...argv], exitCode: event.exitCode });
        if (isChatAuthoringArgv(argv)) {
          const pendingCall = authoringCalls.find((call) => call.exitCode === null && argvEquals(call.argv, argv));
          if (pendingCall) pendingCall.exitCode = event.exitCode;
        }
        if (isChatProgressArgv(argv)) {
          const pendingCall = progressCalls.find((call) => call.exitCode === null && argvEquals(call.argv, argv));
          if (pendingCall) pendingCall.exitCode = event.exitCode;
        }
        if (isHelpArgv(argv)) {
          helpExitCodes.push(event.exitCode);
        }
        if (isReadRouteArgv(argv)) {
          readRouteExitCodes.push(event.exitCode);
        }
        if (isReadActivationArgv(argv)) {
          readActivationResults.push({
            exactCommit: typeof event.exactCommit === "string" ? event.exactCommit : null,
            exitCode: event.exitCode,
          });
        }
        if (isTreeSelectorArgv(argv) && event.exitCode === 0) {
          selectorSnapshotResults.push({
            actualHead: typeof event.actualHead === "string" ? event.actualHead : null,
            detachedHead: event.detachedHead === true,
          });
        }
      }
    }
  }

  const successfulAuthoringCalls = authoringCalls.filter((call) => call.exitCode === 0);
  const successfulProgressCalls = progressCalls.filter((call) => call.exitCode === 0);
  const authoredOutputTexts = successfulAuthoringCalls.map((call) => call.body);
  const factOutputTexts = authoringCalls.length > 0 ? authoredOutputTexts : modelOutputTexts;
  const visibleOutputTexts =
    authoringCalls.length > 0 || progressCalls.length > 0
      ? [...modelOutputTexts, ...successfulProgressCalls.map((call) => call.body), ...authoredOutputTexts]
      : modelOutputTexts;
  // Index-aligned with `visibleOutputTexts` so the grader can tell which surface
  // a note was found on. A blocking question must stay decision-self-sufficient,
  // so a note delivered in a `chat ask` body fails regardless of its shape.
  const visibleOutputKinds: readonly (ManagedTransport | null)[] =
    authoringCalls.length > 0 || progressCalls.length > 0
      ? [
          ...modelOutputTexts.map(() => null),
          ...successfulProgressCalls.map(() => null),
          ...successfulAuthoringCalls.map((call) => chatAuthoringKind(call.argv)),
        ]
      : modelOutputTexts.map(() => null);
  const contextDecisionMetadataPresent = successfulAuthoringCalls.some((call) => call.contextDecisionMetadataPresent);
  const facts = uniqueStrings(expectedFacts);
  const factHits = expectedFactHits(factOutputTexts.join("\n"), facts);
  const helpSucceeded = firstTreeCommandResults.some((result) => isHelpArgv(result.argv) && result.exitCode === 0);
  const selectionSucceeded = firstTreeCommandResults.some(
    (result) => isTreeSelectorArgv(result.argv) && result.exitCode === 0,
  );
  const readActivationSucceeded =
    readActivationCalls === 1 &&
    readActivationResults.length === 1 &&
    readActivationResults[0]?.exitCode === 0 &&
    readActivationResults[0]?.exactCommit !== null;
  const readRouteSucceeded = readRouteCalls === 1 && readRouteExitCodes.length === 1 && readRouteExitCodes[0] === 0;
  const selectorCalls = firstTreeArgv.filter(isTreeSelectorArgv);
  const byoSelectorsNoPull = selectorCalls.length > 0 && selectorCalls.every((argv) => argv.includes("--no-pull"));
  const readRouteIndex = firstTreeArgv.findIndex(isReadRouteArgv);
  const readActivationIndex = firstTreeArgv.findIndex(isReadActivationArgv);
  const hierarchyHelpIndex = firstTreeArgv.findIndex(isHelpArgv);
  const selectorIndexes = firstTreeArgv
    .map((argv, index) => (isTreeSelectorArgv(argv) ? index : -1))
    .filter((index) => index >= 0);
  const byoReadSequenceOk =
    legacyReadActivationCalls === 0 &&
    readRouteIndex >= 0 &&
    readActivationIndex > readRouteIndex &&
    hierarchyHelpIndex > readActivationIndex &&
    selectorIndexes.length > 0 &&
    selectorIndexes.every((index) => index > hierarchyHelpIndex);
  const exactCommit = readActivationResults.find((result) => result.exitCode === 0)?.exactCommit ?? null;
  const byoSnapshotExactHeadConsistent =
    exactCommit !== null &&
    selectorSnapshotResults.length > 0 &&
    selectorSnapshotResults.length === selectorCalls.length &&
    selectorSnapshotResults.every((result) => result.actualHead === exactCommit);
  const byoSnapshotDetached =
    selectorSnapshotResults.length > 0 &&
    selectorSnapshotResults.length === selectorCalls.length &&
    selectorSnapshotResults.every((result) => result.detachedHead);
  const modelFirstTreeCommandsOk = firstTreeCommandResults.every((result) => result.exitCode === 0);
  const selectedExactCommit = exactCommit ?? selectorSnapshotResults.at(-1)?.actualHead ?? null;
  const finalAuthoringKind = chatAuthoringKind(successfulAuthoringCalls.at(-1)?.argv ?? []);
  const managedFinalTransportOk =
    managedTransportExpectation === null || finalAuthoringKind === managedTransportExpectation;
  const impactNoteMetrics = deriveImpactNoteMetrics(visibleOutputTexts, impactNoteExpectation, {
    contextDecisionMetadataPresent,
    selectedExactCommit,
    visibleOutputKinds,
  });
  const artifactViolation =
    options.artifactBaseline != null && options.workspacePath !== undefined
      ? treeArtifactBaselineViolation(options.artifactBaseline, options.workspacePath)
      : { created: false, modified: false };
  // The guard is a PRE/POST comparison against the fixture-setup baseline: a
  // retired stale checkout left on disk is legal residue, but anything newly
  // created — or a stale artifact the run modified — is a violation.
  const unboundTreeArtifactsCreatedValue =
    options.unboundWorkspace === true ? artifactViolation.created || artifactViolation.modified : false;
  const staleTreeArtifactModifiedObserved = options.unresolvedWorkspace === true ? artifactViolation.modified : false;
  const treeCliInvocationCount =
    firstTreeArgv.filter(isTreeOperationArgv).length +
    firstTreeCommandResults.filter((result) => isTreeOperationArgv(result.argv)).length;
  // Negative signals scan every genuinely teammate-visible delivery —
  // successful chat send/ask bodies plus successful chat update (current-state)
  // bodies — never console narration. Console output is the fallback only when
  // the run produced no such deliveries at all.
  const teammateDeliveredTexts = [...authoredOutputTexts, ...successfulProgressCalls.map((call) => call.body)];
  const negativeScanTexts = teammateDeliveredTexts.length > 0 ? teammateDeliveredTexts : modelOutputTexts;
  const treeSetupWordingObserved = negativeScanTexts.some((text) =>
    text
      // Sentence splitting mirrors the detector's own `[^.!?\n]` windows. An
      // unconfirmed-binding sentence is the unresolved-binding gap report —
      // "the binding could not be confirmed" names a state, not setup wording —
      // so it must not trip the Tree…binding alternative.
      .split(/[.!?\n]+/u)
      .filter((sentence) => !UNRESOLVED_REASON.test(sentence))
      .some((sentence) =>
        /\b(?:bind|create|connect|set\s*up|install|register)\b[^.!?\n]{0,60}(?<!first-)\btree\b|(?<!first-)\btree\b[^.!?\n]{0,80}\b(?:binding|creation|setup)\b/iu.test(
          sentence,
        ),
      ),
  );
  const treeSetupSurfaceGuidanceObserved = negativeScanTexts.some((text) => containsTreeSetupSurfaceGuidance(text));
  const unboundSetupSteeringObserved = containsUnboundSetupSteering(negativeScanTexts.join("\n"));
  const unboundAbsenceMentionObserved = negativeScanTexts.some((text) => containsUnboundAbsenceMention(text));
  // The positive gap signal is judged by the LAST real delivery only: an
  // earlier correct gap statement cannot cover a final delivery that drops it.
  // Native final output is the fallback only when no chat authoring exists.
  const finalDeliveredText =
    authoringCalls.length > 0 ? (successfulAuthoringCalls.at(-1)?.body ?? "") : (modelOutputTexts.at(-1) ?? "");
  const unboundGapStatementObserved = containsUnboundGapStatement(finalDeliveredText);
  // The unresolved gap follows the same last-delivery semantics: only the
  // last successful ask/send body (native final fallback only with no chat
  // authoring) can carry it.
  const unresolvedGapStatementObserved = containsUnresolvedGapStatement(finalDeliveredText);
  const unresolvedBindingMentionObserved = negativeScanTexts.some((text) => containsUnresolvedBindingMention(text));

  return {
    expectedFactHits: factHits,
    expectedFactsObserved: facts.length > 0 && factHits.length === facts.length,
    firstTreeArgv,
    firstTreeCalls,
    firstTreeCommandResults,
    fixtureValidationOk: fixtureValidation.ok,
    helpAttempted: helpCalls > 0,
    helpCalls,
    helpExitCodes,
    helpSucceeded,
    ...impactNoteMetrics,
    byoReadSequenceOk,
    byoSelectorsNoPull,
    byoSnapshotDetached,
    byoSnapshotExactHeadConsistent,
    legacyReadActivationCalls,
    modelFirstTreeCommandsOk,
    managedFinalTransportOk,
    managedFinalTransportKind: finalAuthoringKind,
    managedTransportExpected: managedTransportExpectation,
    readActivationCalls,
    readActivationSucceeded,
    readRouteCalls,
    readRouteSucceeded,
    runnerExitCode,
    selectionSucceeded,
    skillFileReadObserved,
    skillHit: skillFileReadObserved || firstTreeCalls > 0 || firstTreeCommandResults.length > 0,
    staleTreeArtifactAccessObserved,
    staleTreeArtifactModifiedObserved,
    treeCliInvocationCount,
    treeSetupWordingObserved,
    treeSetupSurfaceGuidanceObserved,
    unboundAbsenceMentionObserved,
    unboundGapStatementObserved,
    unboundSetupSteeringObserved,
    unboundTreeArtifactsCreated: unboundTreeArtifactsCreatedValue,
    unresolvedBindingMentionObserved,
    unresolvedGapStatementObserved,
  };
}

export function casePassed(
  expectedTrigger: boolean,
  metrics: EvalMetrics,
  readMode: ReadMode = "managed",
  unboundContinuation = false,
  unboundExplicitRead = false,
  unresolvedContinuation = false,
  unresolvedExplicitRead = false,
): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;

  if (!expectedTrigger && unresolvedExplicitRead) {
    // Claiming "no Tree is bound" (unboundAbsenceMentionObserved) fails here:
    // the unconfirmed binding is not a confirmed unbind.
    return (
      metrics.unresolvedGapStatementObserved &&
      metrics.impactNoteBehaviorOk &&
      metrics.managedFinalTransportOk &&
      metrics.treeCliInvocationCount === 0 &&
      metrics.modelFirstTreeCommandsOk &&
      !metrics.treeSetupWordingObserved &&
      !metrics.treeSetupSurfaceGuidanceObserved &&
      !metrics.unboundSetupSteeringObserved &&
      !metrics.unboundAbsenceMentionObserved &&
      !metrics.staleTreeArtifactAccessObserved &&
      !metrics.staleTreeArtifactModifiedObserved
    );
  }

  if (!expectedTrigger && unresolvedContinuation) {
    return (
      metrics.expectedFactsObserved &&
      metrics.impactNoteBehaviorOk &&
      metrics.managedFinalTransportOk &&
      metrics.treeCliInvocationCount === 0 &&
      !metrics.skillFileReadObserved &&
      metrics.modelFirstTreeCommandsOk &&
      !metrics.treeSetupWordingObserved &&
      !metrics.treeSetupSurfaceGuidanceObserved &&
      !metrics.unboundAbsenceMentionObserved &&
      !metrics.unresolvedBindingMentionObserved &&
      !metrics.staleTreeArtifactAccessObserved &&
      !metrics.staleTreeArtifactModifiedObserved
    );
  }

  if (!expectedTrigger && unboundExplicitRead) {
    return (
      metrics.unboundGapStatementObserved &&
      metrics.impactNoteBehaviorOk &&
      metrics.managedFinalTransportOk &&
      metrics.treeCliInvocationCount === 0 &&
      metrics.modelFirstTreeCommandsOk &&
      !metrics.treeSetupWordingObserved &&
      !metrics.treeSetupSurfaceGuidanceObserved &&
      !metrics.unboundSetupSteeringObserved &&
      !metrics.unboundTreeArtifactsCreated &&
      !metrics.staleTreeArtifactAccessObserved
    );
  }

  if (!expectedTrigger && unboundContinuation) {
    return (
      metrics.expectedFactsObserved &&
      metrics.impactNoteBehaviorOk &&
      metrics.managedFinalTransportOk &&
      metrics.treeCliInvocationCount === 0 &&
      !metrics.skillFileReadObserved &&
      metrics.modelFirstTreeCommandsOk &&
      !metrics.treeSetupWordingObserved &&
      !metrics.treeSetupSurfaceGuidanceObserved &&
      !metrics.unboundAbsenceMentionObserved &&
      !metrics.unboundTreeArtifactsCreated &&
      !metrics.staleTreeArtifactAccessObserved
    );
  }

  if (expectedTrigger) {
    const readModePassed =
      readMode === "managed" ||
      (metrics.readRouteSucceeded &&
        metrics.readActivationSucceeded &&
        metrics.byoReadSequenceOk &&
        metrics.byoSelectorsNoPull &&
        metrics.byoSnapshotDetached &&
        metrics.byoSnapshotExactHeadConsistent);
    return (
      metrics.skillFileReadObserved &&
      metrics.expectedFactsObserved &&
      metrics.impactNoteBehaviorOk &&
      metrics.helpSucceeded &&
      metrics.selectionSucceeded &&
      metrics.modelFirstTreeCommandsOk &&
      (readMode === "byo" || metrics.managedFinalTransportOk) &&
      readModePassed
    );
  }

  return (
    !metrics.skillHit &&
    metrics.impactNoteBehaviorOk &&
    metrics.expectedFactHits.length === 0 &&
    metrics.firstTreeCalls === 0 &&
    metrics.firstTreeCommandResults.length === 0 &&
    metrics.modelFirstTreeCommandsOk
  );
}
