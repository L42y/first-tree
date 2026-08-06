import { findStringValue, isRecord, isStringArray } from "../../core/events.js";
import type {
  EvalMetrics,
  FixtureValidation,
  ImpactNoteEffect,
  ImpactNoteExpectation,
  ImpactNoteLanguage,
  ReadMode,
} from "./types.js";

const HELP_ARGV = ["tree", "tree", "--help"];
const READ_HELP_ARGV = ["tree", "read", "--help"];
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
];

const EFFECT_LABELS: Record<ImpactNoteLanguage, Record<ImpactNoteEffect, string>> = {
  en: {
    conflicted: "Conflict surfaced",
    confirmed: "Direction supported",
    constrained: "Options narrowed",
    redirected: "Approach changed",
  },
  zh: {
    conflicted: "发现冲突",
    confirmed: "当前方向得到支持",
    constrained: "选项已收窄",
    redirected: "方案已调整",
  },
};

type ImpactNoteObservation = {
  blankLineBefore: boolean;
  effectLabel: string;
  exactLinksOk: boolean;
  language: ImpactNoteLanguage;
  logicalLinesOk: boolean;
  sourceLabels: readonly string[];
  sourceScaffoldingOk: boolean;
  summary: string;
  summaryObjectiveOk: boolean;
};

function isExactCredentialFreeSourceLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /\/(?:-\/)?blob\/(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\/[^/].*$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function parseImpactNotes(texts: readonly string[]): readonly ImpactNoteObservation[] {
  const observations: ImpactNoteObservation[] = [];

  for (const text of texts) {
    const lines = text.replace(/\r/gu, "").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const firstLine = lines[index] ?? "";
      const titleMatch = /^> \*\*(Context Tree impact|Context Tree 影响) · ([^*]+)\*\*\\$/u.exec(firstLine);
      if (!titleMatch) continue;

      const language: ImpactNoteLanguage = titleMatch[1] === "Context Tree 影响" ? "zh" : "en";
      const secondLine = lines[index + 1] ?? "";
      const thirdLine = lines[index + 2] ?? "";
      const summaryMatch = /^> (.+)\\$/u.exec(secondLine);
      const sourcePrefix = language === "zh" ? /^> \*\*来源\*\* · /u : /^> \*\*(Source|Sources)\*\* · /u;
      const sourcePrefixMatch = sourcePrefix.exec(thirdLine);
      const markdownLinks = [...thirdLine.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu)];
      const exactLinks = markdownLinks.filter((match) => isExactCredentialFreeSourceLink(match[2] ?? ""));
      const expectedEnglishSource = markdownLinks.length === 1 ? "Source" : "Sources";
      const sourceLabel = language === "zh" ? "来源" : expectedEnglishSource;
      const expectedSourceLine = `> **${sourceLabel}** · ${markdownLinks.map((match) => match[0]).join(" · ")}`;
      const sourceScaffoldingOk =
        sourcePrefixMatch !== null &&
        (language === "zh" || sourcePrefixMatch[1] === expectedEnglishSource) &&
        markdownLinks.length > 0 &&
        thirdLine === expectedSourceLine;
      const summary = summaryMatch?.[1]?.trim() ?? "";

      observations.push({
        blankLineBefore: index > 0 && (lines[index - 1] ?? "").trim() === "",
        effectLabel: titleMatch[2]?.trim() ?? "",
        exactLinksOk: exactLinks.length === markdownLinks.length && exactLinks.length > 0,
        language,
        logicalLinesOk:
          summaryMatch !== null && sourcePrefixMatch !== null && !(lines[index + 3] ?? "").startsWith(">"),
        sourceLabels: markdownLinks.map((match) => match[1] ?? ""),
        sourceScaffoldingOk,
        summary,
        summaryObjectiveOk: !/(^|\s)(I|We)\s+(used?|read|consulted)|我(使用|读取|参考)了?\s*Context Tree/iu.test(
          summary,
        ),
      });
    }
  }

  return observations;
}

function includesAny(value: string, alternatives: readonly string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return alternatives.some((alternative) => normalized.includes(alternative.toLocaleLowerCase()));
}

function deriveImpactNoteMetrics(texts: readonly string[], expectation: ImpactNoteExpectation) {
  const observations = parseImpactNotes(texts);
  const observation = observations[0] ?? null;
  const allText = texts.join("\n");
  const metadataFree = !/contextDecision|["']effect["']\s*:|["']evidence["']\s*:/u.test(allText);
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
    expectation.mode === "present" ? EFFECT_LABELS[expectation.language][expectation.effect] : null;
  const behaviorOk =
    expectation.mode === "absent"
      ? observations.length === 0 && metadataFree
      : observations.length === 1 &&
        observation !== null &&
        observation.blankLineBefore &&
        observation.logicalLinesOk &&
        observation.sourceScaffoldingOk &&
        observation.summaryObjectiveOk &&
        observation.exactLinksOk &&
        observation.language === expectation.language &&
        observation.effectLabel === expectedEffectLabel &&
        sourceCountOk &&
        requiredSourceLabelsOk &&
        summaryConceptsOk &&
        summaryForbiddenOk &&
        metadataFree;

  return {
    impactNoteBehaviorOk: behaviorOk,
    impactNoteBlankLineBefore: observation?.blankLineBefore ?? false,
    impactNoteCount: observations.length,
    impactNoteEffect: observation?.effectLabel ?? null,
    impactNoteExactLinksOk: observation?.exactLinksOk ?? false,
    impactNoteLanguage: observation?.language ?? null,
    impactNoteLogicalLinesOk: observation?.logicalLinesOk ?? false,
    impactNoteMetadataFree: metadataFree,
    impactNoteSourceCount: observation?.sourceLabels.length ?? 0,
    impactNoteSourceLabels: observation?.sourceLabels ?? [],
    impactNoteSummaryConceptsOk: summaryConceptsOk,
    impactNoteSummaryForbiddenOk: summaryForbiddenOk,
    impactNoteSummaryObjectiveOk: observation?.summaryObjectiveOk ?? false,
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

function isReadHelpArgv(argv: readonly string[]): boolean {
  return argvEquals(commandArgv(argv), READ_HELP_ARGV);
}

function isReadActivationArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "tree" && command[1] === "read" && !isReadHelpArgv(argv);
}

function isTreeTreeArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "tree" && command[1] === "tree";
}

function isTreeSelectorArgv(argv: readonly string[]): boolean {
  return isTreeTreeArgv(argv) && !isHelpArgv(argv);
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

export function deriveMetrics(
  events: readonly unknown[],
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
  expectedFacts: readonly string[],
  impactNoteExpectation: ImpactNoteExpectation = { mode: "absent" },
): EvalMetrics {
  let firstTreeCalls = 0;
  let helpCalls = 0;
  let readActivationCalls = 0;
  let skillFileReadObserved = false;
  const firstTreeArgv: string[][] = [];
  const firstTreeCommandResults: Array<{ argv: string[]; exitCode: number }> = [];
  const helpExitCodes: number[] = [];
  const deliveredOutputTexts: string[] = [];
  const modelOutputTexts: string[] = [];
  const readActivationResults: Array<{ exactCommit: string | null; exitCode: number }> = [];
  const readHelpExitCodes: number[] = [];
  const selectorSnapshotResults: Array<{ actualHead: string | null; detachedHead: boolean }> = [];

  for (const event of events) {
    if (containsSkillFileRead(event)) {
      skillFileReadObserved = true;
    }

    modelOutputTexts.push(...collectModelOutputText(event));

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_result") && isModelPhase(event)) {
      const argv = event.argv;
      if (!isStringArray(argv)) continue;

      if (type === "first_tree_call") {
        firstTreeCalls += 1;
        firstTreeArgv.push([...argv]);
        const command = commandArgv(argv);
        if (
          command[0] === "chat" &&
          (command[1] === "send" || command[1] === "ask") &&
          typeof event.body === "string"
        ) {
          deliveredOutputTexts.push(event.body);
        }
        if (isHelpArgv(argv)) {
          helpCalls += 1;
        }
        if (isReadActivationArgv(argv)) {
          readActivationCalls += 1;
        }
      }

      if (type === "first_tree_result" && typeof event.exitCode === "number") {
        firstTreeCommandResults.push({ argv: [...argv], exitCode: event.exitCode });
        if (isHelpArgv(argv)) {
          helpExitCodes.push(event.exitCode);
        }
        if (isReadHelpArgv(argv)) {
          readHelpExitCodes.push(event.exitCode);
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

  const visibleOutputTexts = deliveredOutputTexts.length > 0 ? deliveredOutputTexts : uniqueStrings(modelOutputTexts);
  const facts = uniqueStrings(expectedFacts);
  const factHits = expectedFactHits(visibleOutputTexts.join("\n"), facts);
  const helpSucceeded = firstTreeCommandResults.some((result) => isHelpArgv(result.argv) && result.exitCode === 0);
  const selectionSucceeded = firstTreeCommandResults.some(
    (result) => isTreeSelectorArgv(result.argv) && result.exitCode === 0,
  );
  const readActivationSucceeded =
    readActivationCalls === 1 &&
    readActivationResults.length === 1 &&
    readActivationResults[0]?.exitCode === 0 &&
    readActivationResults[0]?.exactCommit !== null;
  const readHelpSucceeded = readHelpExitCodes.some((exitCode) => exitCode === 0);
  const selectorCalls = firstTreeArgv.filter(isTreeSelectorArgv);
  const byoSelectorsNoPull = selectorCalls.length > 0 && selectorCalls.every((argv) => argv.includes("--no-pull"));
  const readHelpIndex = firstTreeArgv.findIndex(isReadHelpArgv);
  const readActivationIndex = firstTreeArgv.findIndex(isReadActivationArgv);
  const hierarchyHelpIndex = firstTreeArgv.findIndex(isHelpArgv);
  const selectorIndexes = firstTreeArgv
    .map((argv, index) => (isTreeSelectorArgv(argv) ? index : -1))
    .filter((index) => index >= 0);
  const byoReadSequenceOk =
    readHelpIndex >= 0 &&
    readActivationIndex > readHelpIndex &&
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
  const impactNoteMetrics = deriveImpactNoteMetrics(visibleOutputTexts, impactNoteExpectation);

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
    modelFirstTreeCommandsOk,
    readActivationCalls,
    readActivationSucceeded,
    readHelpSucceeded,
    runnerExitCode,
    selectionSucceeded,
    skillFileReadObserved,
    skillHit: skillFileReadObserved || firstTreeCalls > 0 || firstTreeCommandResults.length > 0,
  };
}

export function casePassed(expectedTrigger: boolean, metrics: EvalMetrics, readMode: ReadMode = "managed"): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;

  if (expectedTrigger) {
    const readModePassed =
      readMode === "managed" ||
      (metrics.readHelpSucceeded &&
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
