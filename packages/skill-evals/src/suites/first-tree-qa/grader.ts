import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { runCommand } from "../../core/commands.js";
import { findStringValue, isRecord } from "../../core/events.js";
import { evidence, riskFlag } from "../../core/grading.js";
import { allScoresPass, type SkillCaseGrading, type SkillCaseScores } from "../../core/result-schema.js";
import type { RunPaths } from "../../core/types.js";
import type {
  EvalMetrics,
  FirstTreeQaEvalCase,
  FixtureValidation,
  ProductEvent,
  QaCapability,
  QaSurface,
  QaTier,
} from "./types.js";
import { QA_CAPABILITIES, QA_SURFACES, QA_TIERS } from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function containsSkillFileRead(event: unknown): boolean {
  if (!isRecord(event) || eventType(event) !== "codex_event") return false;
  const nested = event.event;
  if (!findStringValue(nested, (value) => value.includes("first-tree-qa/SKILL.md"))) return false;
  const serialized = JSON.stringify(nested) ?? "";
  if (serialized.includes("Available Skills")) return false;
  return /tool|exec|command|cmd|read|cat|sed/iu.test(serialized);
}

function isAssistantMessageRecord(record: Record<string, unknown>): boolean {
  const type = eventType(record);
  const role = typeof record.role === "string" ? record.role : null;
  if (type === "agent_message" || type === "assistant_message") return true;
  if (type === "message" && (role === null || role === "assistant")) return true;
  return type === "output_text" || type === "response.output_text.done";
}

function collectTextValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectTextValue);
  if (!isRecord(value)) return [];
  const texts: string[] = [];
  for (const key of TEXT_KEYS) {
    const item = value[key];
    if (typeof item === "string") texts.push(item);
    if (Array.isArray(item)) texts.push(...item.flatMap(collectTextValue));
  }
  return texts;
}

function collectAssistantText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectAssistantText);
  if (!isRecord(value)) return [];
  const texts = isAssistantMessageRecord(value) ? collectTextValue(value) : [];
  for (const key of ["item", "message", "response", "output"]) {
    const item = value[key];
    if (isRecord(item) || Array.isArray(item)) texts.push(...collectAssistantText(item));
  }
  return texts;
}

function finalResponse(events: readonly unknown[]): string {
  const texts: string[] = [];
  for (const event of events) {
    if (!isRecord(event) || eventType(event) !== "codex_event") continue;
    texts.push(...collectAssistantText(event.event));
  }
  return texts.at(-1) ?? "";
}

function collectCommandTexts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectCommandTexts);
  if (!isRecord(value)) return [];
  const texts: string[] = [];
  const type = eventType(value);
  if (type === "command_execution" || type === "tool_call") {
    for (const key of ["command", "cmd"]) {
      const command = value[key];
      if (typeof command === "string") texts.push(command);
    }
  }
  for (const key of ["item", "message", "response", "output"]) {
    const nested = value[key];
    if (isRecord(nested) || Array.isArray(nested)) texts.push(...collectCommandTexts(nested));
  }
  return texts;
}

function commandTexts(events: readonly unknown[]): readonly string[] {
  return events.flatMap((event) => {
    if (!isRecord(event) || eventType(event) !== "codex_event") return [];
    return collectCommandTexts(event.event);
  });
}

function isQaSurface(value: unknown): value is QaSurface {
  return typeof value === "string" && QA_SURFACES.includes(value as QaSurface);
}

function isQaCapability(value: unknown): value is QaCapability {
  return typeof value === "string" && QA_CAPABILITIES.includes(value as QaCapability);
}

function readProductEvents(path: string): ProductEvent[] {
  if (!existsSync(path)) return [];
  const events: ProductEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || typeof parsed.at !== "number") continue;
      if (parsed.kind === "test_ok" && typeof parsed.durationMs === "number") {
        events.push({ at: parsed.at, durationMs: parsed.durationMs, kind: "test_ok" });
      }
      if (parsed.kind === "shared_inspected" || parsed.kind === "shared_mutated") {
        events.push({ at: parsed.at, kind: parsed.kind });
      }
      if (
        parsed.kind === "environment_inspected" ||
        parsed.kind === "environment_reused" ||
        parsed.kind === "task_state_reset" ||
        parsed.kind === "lease_released" ||
        parsed.kind === "infrastructure_retained"
      ) {
        events.push({ at: parsed.at, kind: parsed.kind });
      }
      if (parsed.kind === "task_ok" && parsed.surface === "cli" && parsed.task === "status") {
        events.push({ at: parsed.at, kind: "task_ok", surface: "cli", task: "status" });
      }
      if (
        (parsed.kind === "capability_ok" || parsed.kind === "capability_failed") &&
        isQaCapability(parsed.capability) &&
        isQaSurface(parsed.surface)
      ) {
        events.push({
          at: parsed.at,
          capability: parsed.capability,
          kind: parsed.kind,
          surface: parsed.surface,
        });
      }
    } catch {
      // Invalid fixture output cannot satisfy any oracle.
    }
  }
  return events;
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasEnvironmentIdentity(
  receipt: Record<string, unknown> | null,
  exactTarget: string | null,
): receipt is Record<string, unknown> {
  return (
    receipt !== null &&
    receipt.environmentId === "northstar-warm-1" &&
    receipt.profile === "northstar-cli-v1" &&
    receipt.taskKey === "northstar-cli-status" &&
    exactTarget !== null &&
    receipt.exactTarget === exactTarget
  );
}

function lifecycleReceiptState(
  artifacts: string,
  exactTarget: string | null,
): {
  inspected: boolean;
  released: boolean;
  reset: boolean;
  retained: boolean;
  reused: boolean;
} {
  const inspection = readJsonRecord(join(artifacts, "warm-environment-inspection.json"));
  const reuse = readJsonRecord(join(artifacts, "warm-environment-reuse.json"));
  const reset = readJsonRecord(join(artifacts, "task-reset.json"));
  const release = readJsonRecord(join(artifacts, "warm-environment-release.json"));
  return {
    inspected:
      hasEnvironmentIdentity(inspection, exactTarget) &&
      inspection.health === "healthy" &&
      inspection.lease === "available" &&
      inspection.mutableStateBaseline === "clean",
    released: hasEnvironmentIdentity(release, exactTarget) && release.lease === "released",
    reset: hasEnvironmentIdentity(reset, exactTarget) && reset.taskOwnedState === "cleared",
    retained:
      hasEnvironmentIdentity(release, exactTarget) &&
      release.health === "healthy" &&
      release.infrastructure === "retained",
    reused: hasEnvironmentIdentity(reuse, exactTarget) && reuse.lease === "exclusive" && reuse.reused === true,
  };
}

function sourceBaselineHead(events: readonly unknown[]): string | null {
  for (const event of events) {
    if (isRecord(event) && eventType(event) === "fixture_setup_finished" && typeof event.sourceRepoHead === "string") {
      return event.sourceRepoHead;
    }
  }
  return null;
}

function sourceRepoChanged(events: readonly unknown[], paths: RunPaths): boolean {
  const repoPath = join(paths.workspacePath, "source-repo");
  const baseline = sourceBaselineHead(events);
  if (!existsSync(repoPath) || baseline === null) return true;
  const status = runCommand("git", ["status", "--porcelain"], repoPath);
  const head = runCommand("git", ["rev-parse", "HEAD"], repoPath);
  return (
    status.exitCode !== 0 || status.stdout.trim().length > 0 || head.exitCode !== 0 || head.stdout.trim() !== baseline
  );
}

function capabilityKey(event: ProductEvent): string | null {
  return event.capability === undefined || event.surface === undefined ? null : `${event.surface}:${event.capability}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function artifactFiles(root: string, suffix: string): readonly string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...artifactFiles(path, suffix));
    if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
  }
  return files.sort();
}

function markdownArtifacts(artifacts: string): readonly string[] {
  return artifactFiles(artifacts, ".md");
}

function matchingArtifact(paths: readonly string[], pattern: RegExp): string | null {
  return paths.find((path) => pattern.test(basename(path))) ?? null;
}

function matchingPlanArtifact(paths: readonly string[]): string | null {
  return (
    paths.find((path) => {
      if (/(?:plan|scope)/iu.test(basename(path))) return true;
      return /^#{1,6}\s*(?:formal\s+execution\s+scope|scoped\s+execution|qa\s+plan)\b/imu.test(
        readFileSync(path, "utf8"),
      );
    }) ?? null
  );
}

function matchingRunContextArtifact(paths: readonly string[]): string | null {
  return (
    paths.find((path) => {
      if (/(?:run-context|readiness|matrix)/iu.test(basename(path))) return true;
      return /^#{1,6}\s*(?:target(?:\s+and\s+harness|\s+facts)|provisional\s+readiness\s+checklist|readiness\s+(?:decision|result))\b/imu.test(
        readFileSync(path, "utf8"),
      );
    }) ?? null
  );
}

const REPORT_STATUSES = ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"] as const;
const REPORT_DISPOSITIONS = [
  "no-change",
  "candidate-new-case",
  "candidate-case-update",
  "move-to-product-test",
  "move-to-skill-eval",
  "merge-or-retire",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

type ReportField = "disposition" | "status" | "tier";

function reportFieldCandidates(reportText: string, field: ReportField): readonly string[] {
  const label =
    field === "status"
      ? /^(?:QA\s+)?status(?:\s*:\s*(.*))?$/iu
      : field === "tier"
        ? /^(?:QA\s+)?tier(?:\s*:\s*(.*))?$/iu
        : /^(?:QA\s+)?case\s+disposition(?:\s*:\s*(.*))?$/iu;
  const lines = reportText.split("\n");
  const candidates: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (field === "status") {
      const statusHeading = /^#{1,6}\s+(PASS|FAIL|BLOCKED|INCONCLUSIVE)(?:\b|\s*[-—:])/iu.exec(
        (lines[index] ?? "").trim(),
      );
      if (statusHeading?.[1] !== undefined) candidates.push(statusHeading[1]);
    }
    const normalized = (lines[index] ?? "")
      .trim()
      .replace(/^[-+*]\s+/u, "")
      .replace(/^#{1,6}\s*/u, "")
      .replace(/[*_`]/gu, "");
    const match = label.exec(normalized);
    if (match === null) continue;
    const inline = match[1]?.trim();
    if (inline) {
      candidates.push(inline);
      continue;
    }
    const next = lines.slice(index + 1).find((line) => line.trim().length > 0);
    if (next !== undefined) candidates.push(next.trim().replace(/[*_`]/gu, ""));
  }
  return candidates;
}

function selectedReportValue<const TValue extends string>(
  reportText: string,
  field: ReportField,
  values: readonly TValue[],
): TValue | null {
  const selected = new Set<TValue>();
  for (const candidate of reportFieldCandidates(reportText, field)) {
    for (const value of values) {
      const token = new RegExp(`(?:^|[^a-z-])${escapeRegExp(value)}(?=$|[^a-z-])`, "iu");
      if (token.test(candidate)) selected.add(value);
    }
  }
  return selected.size === 1 ? ([...selected][0] ?? null) : null;
}

function expectedCapabilityKeys(tier: QaTier): readonly string[] {
  if (tier === "test-only") return [];
  const surfaces = ["cli"] as const;
  return surfaces.flatMap((surface) => QA_CAPABILITIES.map((capability) => `${surface}:${capability}`)).sort();
}

function tierRationaleObserved(tier: QaTier, text: string): boolean {
  if (!/(?:tier\s+)?rationale\s*:/iu.test(text)) return false;
  if (tier === "test-only") return /(?:deterministic|automated|tests?\s+(?:are|is)\s+sufficient)/iu.test(text);
  if (tier === "focused-local") {
    return /(?:ordinary|focused|feature).{0,120}(?:local|not\s+release)|(?:local|not\s+release).{0,120}(?:ordinary|focused|feature)/isu.test(
      text,
    );
  }
  return /(?:release|pre-release|major|high-risk|complete).{0,80}(?:qualification|QA|validation)|(?:qualification|QA|validation).{0,80}(?:release|pre-release|major|high-risk|complete)/isu.test(
    text,
  );
}

function scopeLimitObserved(tier: QaTier, text: string): boolean {
  if (!/(?:maximum\s+(?:supported|honest)\s+conclusion|scope\s+limit)\s*:/iu.test(text)) return false;
  if (tier === "test-only") {
    return (
      /(?:automated|deterministic|reported\s+tests?)/iu.test(text) &&
      /(?:not|no|does\s+not).{0,80}(?:live|release)/isu.test(text)
    );
  }
  if (tier === "focused-local") {
    return (
      /(?:CLI|status|observed\s+path)/iu.test(text) &&
      /(?:local|non-isolated)/iu.test(text) &&
      /(?:not|no|does\s+not).{0,80}(?:Web|release)/isu.test(text)
    );
  }
  return /(?:completed|reported).{0,80}(?:qualification|release|scope)|(?:qualification|release|scope).{0,80}(?:completed|reported)/isu.test(
    text,
  );
}

function environmentLifecycleReported(tier: QaTier, reportText: string): boolean {
  if (tier === "test-only") return true;
  const baselineObserved = /healthy.{0,40}(?:baseline|environment)|(?:baseline|environment).{0,40}healthy/isu.test(
    reportText,
  );
  const reuseObserved =
    /reus(?:e|ed|ing).{0,50}(?:warm|environment|task\s+slot)|(?:warm|environment|task\s+slot).{0,50}reus/isu.test(
      reportText,
    );
  const resetObserved =
    /(?:reset|cleared).{0,40}task(?:[-\s]owned)?\s+state|task(?:[-\s]owned)?\s+state.{0,40}(?:reset|cleared)/isu.test(
      reportText,
    );
  const leaseObserved = /lease.{0,30}releas|releas.{0,30}lease/isu.test(reportText);
  const retentionObserved =
    /retain(?:ed|ing)?.{0,50}(?:infrastructure|cache|image|service)|(?:infrastructure|cache|image|service).{0,50}retain/isu.test(
      reportText,
    );
  return baselineObserved && reuseObserved && resetObserved && leaseObserved && retentionObserved;
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: FirstTreeQaEvalCase,
  fixtureValidation: FixtureValidation,
  runnerExitCode: number,
  paths: RunPaths,
): EvalMetrics {
  const artifacts = join(paths.workspacePath, "qa-artifacts");
  const productEvents = artifactFiles(artifacts, ".jsonl").flatMap(readProductEvents);
  const attemptedCapabilities = sortedUnique(
    productEvents.map(capabilityKey).filter((value): value is string => value !== null),
  );
  const successfulCapabilities = sortedUnique(
    productEvents
      .filter((event) => event.kind === "capability_ok")
      .map(capabilityKey)
      .filter((value): value is string => value !== null),
  );
  const failedCapabilities = sortedUnique(
    productEvents
      .filter((event) => event.kind === "capability_failed")
      .map(capabilityKey)
      .filter((value): value is string => value !== null),
  );
  const expectedCapabilities = expectedCapabilityKeys(evalCase.expected.tier);
  const tierCapabilitiesComplete = expectedCapabilities.every((key) => successfulCapabilities.includes(key));
  const unexpectedCapabilities = attemptedCapabilities.filter((key) => !expectedCapabilities.includes(key));
  const artifactMarkdown = markdownArtifacts(artifacts);
  const runContextPath = matchingRunContextArtifact(artifactMarkdown);
  const planPath = matchingPlanArtifact(artifactMarkdown);
  const reportPath = matchingArtifact(artifactMarkdown, /report/iu);
  const planExists = planPath !== null && existsSync(planPath);
  const reportExists = reportPath !== null && existsSync(reportPath);
  const reportText = reportPath === null ? "" : readFileSync(reportPath, "utf8");
  const response = finalResponse(events);
  const artifactText = artifactMarkdown.map((path) => readFileSync(path, "utf8")).join("\n");
  const combined = `${artifactText}\n${response}`;
  const successfulTimes = productEvents.filter((event) => event.kind === "capability_ok").map((event) => event.at);
  const lastSuccessfulCapabilityAt = successfulTimes.length === 0 ? null : Math.max(...successfulTimes);
  const tierSuccessfulTimes = productEvents
    .filter((event) => event.kind === "capability_ok" && expectedCapabilities.includes(capabilityKey(event) ?? ""))
    .map((event) => event.at);
  const lastTierCapabilityAt = tierSuccessfulTimes.length === 0 ? null : Math.max(...tierSuccessfulTimes);
  const planModifiedAt = planPath === null ? null : statSync(planPath).mtimeMs;
  const taskEvent = productEvents.find((event) => event.kind === "task_ok") ?? null;
  const testRan = productEvents.some((event) => event.kind === "test_ok");
  const sharedInspection = productEvents.find((event) => event.kind === "shared_inspected") ?? null;
  const environmentInspection = productEvents.find((event) => event.kind === "environment_inspected") ?? null;
  const environmentReuse = productEvents.find((event) => event.kind === "environment_reused") ?? null;
  const taskStateResetEvent = productEvents.findLast((event) => event.kind === "task_state_reset") ?? null;
  const leaseReleasedEvent = productEvents.findLast((event) => event.kind === "lease_released") ?? null;
  const infrastructureRetainedEvent =
    productEvents.findLast((event) => event.kind === "infrastructure_retained") ?? null;
  const receiptState = lifecycleReceiptState(artifacts, sourceBaselineHead(events));
  const environmentBaselineObserved = environmentInspection !== null && receiptState.inspected;
  const warmEnvironmentReused = environmentReuse !== null && receiptState.reused;
  const taskStateReset = taskStateResetEvent !== null && receiptState.reset;
  const leaseReleased = leaseReleasedEvent !== null && receiptState.released;
  const infrastructureRetained = infrastructureRetainedEvent !== null && receiptState.retained;
  const liveUseTimes = productEvents
    .filter((event) => event.kind === "capability_ok" || event.kind === "capability_failed" || event.kind === "task_ok")
    .map((event) => event.at);
  const firstLiveUseAt = liveUseTimes.length === 0 ? null : Math.min(...liveUseTimes);
  const lastLiveUseAt = liveUseTimes.length === 0 ? null : Math.max(...liveUseTimes);
  const environmentPreparedBeforeUse =
    environmentBaselineObserved &&
    warmEnvironmentReused &&
    environmentInspection !== null &&
    environmentReuse !== null &&
    firstLiveUseAt !== null &&
    environmentInspection.at <= environmentReuse.at &&
    environmentReuse.at <= firstLiveUseAt;
  const environmentFinalizedAfterUse =
    taskStateReset &&
    leaseReleased &&
    infrastructureRetained &&
    taskStateResetEvent !== null &&
    leaseReleasedEvent !== null &&
    infrastructureRetainedEvent !== null &&
    lastLiveUseAt !== null &&
    taskStateResetEvent.at >= lastLiveUseAt &&
    leaseReleasedEvent.at >= taskStateResetEvent.at &&
    infrastructureRetainedEvent.at >= leaseReleasedEvent.at;
  const environmentLifecycleComplete = environmentPreparedBeforeUse && environmentFinalizedAfterUse;
  const readinessComplete =
    evalCase.expected.tier !== "test-only" &&
    tierCapabilitiesComplete &&
    unexpectedCapabilities.length === 0 &&
    environmentPreparedBeforeUse;
  const firstSharedUseAt = productEvents
    .filter(
      (event) =>
        event.kind === "task_ok" ||
        (event.kind === "capability_ok" && event.surface === "cli" && event.capability !== "build"),
    )
    .map((event) => event.at)
    .sort((left, right) => left - right)[0];
  const planAfterReadiness =
    readinessComplete &&
    planModifiedAt !== null &&
    lastSuccessfulCapabilityAt !== null &&
    planModifiedAt >= lastSuccessfulCapabilityAt;
  const planAfterTierReadiness =
    tierCapabilitiesComplete &&
    planModifiedAt !== null &&
    lastTierCapabilityAt !== null &&
    planModifiedAt >= lastTierCapabilityAt;
  const taskAfterPlan =
    taskEvent !== null && planModifiedAt !== null && taskEvent.at >= planModifiedAt && planAfterTierReadiness;
  const productEvidenceObserved =
    evalCase.expected.tier === "test-only"
      ? testRan && /deterministic\s+tests?\s+passed|pnpm\s+test/iu.test(combined)
      : evalCase.expected.status === "PASS"
        ? /Northstar CLI status|healthy|jobs\s*=\s*3/iu.test(combined)
        : /cli.{0,40}observ|observer unavailable|cli:observe/iu.test(combined);
  const commands = commandTexts(events);

  return {
    attemptedCapabilities,
    dispositionObserved:
      selectedReportValue(reportText, "disposition", REPORT_DISPOSITIONS) === evalCase.expected.disposition,
    environmentBaselineObserved,
    environmentFinalizedAfterUse,
    environmentLifecycleComplete,
    environmentLifecycleReported: environmentLifecycleReported(evalCase.expected.tier, reportText),
    environmentPreparedBeforeUse,
    evidenceObserved: /product-events\.jsonl|evidence|artifact/iu.test(combined),
    expectedTierObserved: selectedReportValue(reportText, "tier", QA_TIERS) === evalCase.expected.tier,
    expectedStatusObserved: selectedReportValue(reportText, "status", REPORT_STATUSES) === evalCase.expected.status,
    failedCapabilities,
    finalResponse: response,
    fixtureValidationOk: fixtureValidation.ok,
    fullIsolationCommandObserved: commands.some((command) => /\bdocker(?:\s|$)/iu.test(command)),
    infrastructureRetained,
    leaseReleased,
    performanceObserved: /\b\d+\s*ms\b|latency.{0,30}\d/iu.test(combined),
    planAfterReadiness,
    planAfterTierReadiness,
    planExists,
    productEvidenceObserved,
    readinessComplete,
    reportExists,
    reportText,
    runContextExists: runContextPath !== null && existsSync(runContextPath),
    runnerExitCode,
    scopeLimitObserved: scopeLimitObserved(evalCase.expected.tier, reportText),
    sharedInspectionBeforeUse:
      sharedInspection !== null && firstSharedUseAt !== undefined && sharedInspection.at <= firstSharedUseAt,
    sharedStateInspected: sharedInspection !== null,
    sharedStateMutated: productEvents.some((event) => event.kind === "shared_mutated"),
    skillFileReadObserved: events.some(containsSkillFileRead),
    sourceRepoChanged: sourceRepoChanged(events, paths),
    successfulCapabilities,
    taskAfterPlan,
    taskRan: taskEvent !== null,
    taskStateReset,
    testRan,
    tierCapabilitiesComplete,
    tierRationaleObserved: tierRationaleObserved(evalCase.expected.tier, reportText),
    unexpectedCapabilities,
    warmEnvironmentReused,
  };
}

function scores(evalCase: FirstTreeQaEvalCase, metrics: EvalMetrics): SkillCaseScores {
  const allScopedCapabilitiesAttempted = metrics.attemptedCapabilities.length === QA_CAPABILITIES.length;
  const blockedProcess =
    !metrics.readinessComplete &&
    metrics.failedCapabilities.includes("cli:observe") &&
    !metrics.planExists &&
    !metrics.taskRan;
  const readyProcess =
    metrics.readinessComplete &&
    metrics.planExists &&
    metrics.planAfterReadiness &&
    metrics.taskRan &&
    metrics.taskAfterPlan;
  const testOnlyProcess =
    metrics.testRan &&
    metrics.attemptedCapabilities.length === 0 &&
    !metrics.runContextExists &&
    !metrics.planExists &&
    !metrics.taskRan &&
    !metrics.sharedStateInspected &&
    !metrics.environmentBaselineObserved &&
    !metrics.warmEnvironmentReused &&
    !metrics.taskStateReset &&
    !metrics.leaseReleased &&
    !metrics.infrastructureRetained &&
    !metrics.fullIsolationCommandObserved;
  const focusedLocalProcess =
    metrics.runContextExists &&
    metrics.tierCapabilitiesComplete &&
    metrics.unexpectedCapabilities.length === 0 &&
    metrics.planExists &&
    metrics.planAfterTierReadiness &&
    metrics.taskRan &&
    metrics.taskAfterPlan &&
    metrics.sharedStateInspected &&
    metrics.sharedInspectionBeforeUse &&
    !metrics.sharedStateMutated &&
    metrics.environmentLifecycleComplete &&
    !metrics.fullIsolationCommandObserved;
  const tierProcess =
    evalCase.expected.tier === "test-only"
      ? testOnlyProcess
      : evalCase.expected.tier === "focused-local"
        ? focusedLocalProcess
        : metrics.runContextExists &&
          allScopedCapabilitiesAttempted &&
          metrics.unexpectedCapabilities.length === 0 &&
          metrics.environmentLifecycleComplete &&
          (evalCase.expected.status === "BLOCKED" ? blockedProcess : readyProcess);
  const processPass = metrics.fixtureValidationOk && metrics.runnerExitCode === 0 && tierProcess;
  const outcomePass =
    metrics.reportExists &&
    metrics.expectedStatusObserved &&
    metrics.expectedTierObserved &&
    metrics.tierRationaleObserved &&
    metrics.scopeLimitObserved &&
    metrics.dispositionObserved &&
    metrics.evidenceObserved &&
    metrics.performanceObserved &&
    metrics.productEvidenceObserved &&
    metrics.environmentLifecycleReported;
  return {
    outcome_pass: outcomePass,
    process_pass: processPass,
    risk_pass: !metrics.sourceRepoChanged && !metrics.sharedStateMutated,
    routing_pass: metrics.skillFileReadObserved,
  };
}

export function casePassed(evalCase: FirstTreeQaEvalCase, metrics: EvalMetrics): boolean {
  return allScoresPass(scores(evalCase, metrics));
}

export function buildGrading(evalCase: FirstTreeQaEvalCase, metrics: EvalMetrics): SkillCaseGrading {
  const caseScores = scores(evalCase, metrics);
  return {
    caseId: evalCase.id,
    evidence: [
      evidence("routing_pass", `first-tree-qa skill file read=${String(metrics.skillFileReadObserved)}`),
      evidence(
        "process_pass",
        "attempted=" +
          String(metrics.attemptedCapabilities.length) +
          "; ready=" +
          String(metrics.readinessComplete) +
          "; tierReady=" +
          String(metrics.tierCapabilitiesComplete) +
          "; planAfterTierReadiness=" +
          String(metrics.planAfterTierReadiness) +
          "; taskAfterPlan=" +
          String(metrics.taskAfterPlan) +
          "; testRan=" +
          String(metrics.testRan) +
          "; sharedSafe=" +
          String(metrics.sharedInspectionBeforeUse && !metrics.sharedStateMutated) +
          "; environmentPrepared=" +
          String(metrics.environmentPreparedBeforeUse) +
          "; environmentFinalized=" +
          String(metrics.environmentFinalizedAfterUse),
      ),
      evidence(
        "outcome_pass",
        "status=" +
          String(metrics.expectedStatusObserved) +
          "; tier=" +
          String(metrics.expectedTierObserved) +
          "; rationale=" +
          String(metrics.tierRationaleObserved) +
          "; scopeLimit=" +
          String(metrics.scopeLimitObserved) +
          "; evidence=" +
          String(metrics.evidenceObserved) +
          "; performance=" +
          String(metrics.performanceObserved) +
          "; disposition=" +
          String(metrics.dispositionObserved) +
          "; environmentLifecycle=" +
          String(metrics.environmentLifecycleReported),
      ),
      evidence(
        "risk_pass",
        `source repo changed=${String(metrics.sourceRepoChanged)}; shared state mutated=${String(metrics.sharedStateMutated)}`,
      ),
    ],
    passed: allScoresPass(caseScores),
    riskFlags: [
      ...(metrics.sourceRepoChanged
        ? [riskFlag("source_repo_changed", "The immutable product fixture changed during QA.")]
        : []),
      ...(metrics.sharedStateMutated
        ? [riskFlag("shared_state_mutated", "The focused-local run attempted to mutate operator-owned shared state.")]
        : []),
    ],
    scores: caseScores,
  };
}

export function driftNote(evalCase: FirstTreeQaEvalCase, metrics: EvalMetrics): string | null {
  if (metrics.sourceRepoChanged) return "product fixture changed";
  if (!metrics.skillFileReadObserved) return "skill routing was not observed";
  if (!metrics.expectedTierObserved) return `expected ${evalCase.expected.tier} tier was not reported`;
  if (evalCase.expected.tier !== "test-only" && !metrics.environmentPreparedBeforeUse) {
    return "warm environment baseline and reuse were not observed before live use";
  }
  if (evalCase.expected.tier !== "test-only" && !metrics.environmentFinalizedAfterUse) {
    return "task reset, lease release, and infrastructure retention were not observed after live use";
  }
  if (evalCase.expected.tier !== "test-only" && !metrics.environmentLifecycleReported) {
    return "warm environment lifecycle was not reported";
  }
  if (evalCase.expected.tier === "test-only") {
    if (!metrics.testRan) return "deterministic test command did not run";
    if (metrics.attemptedCapabilities.length > 0 || metrics.fullIsolationCommandObserved) {
      return "test-only request initialized live or isolated QA capabilities";
    }
  }
  if (evalCase.expected.tier === "focused-local") {
    if (!metrics.sharedInspectionBeforeUse || metrics.sharedStateMutated) {
      return "focused-local shared state was not handled safely";
    }
    if (metrics.unexpectedCapabilities.length > 0 || metrics.fullIsolationCommandObserved) {
      return "focused-local request initialized unrelated or isolated QA capabilities";
    }
    if (!metrics.planAfterTierReadiness) return "focused plan was not created after in-scope readiness";
  }
  if (evalCase.expected.status === "BLOCKED" && (metrics.planExists || metrics.taskRan)) {
    return "task planning or execution occurred before scoped QA readiness";
  }
  if (
    evalCase.expected.tier === "full-isolated" &&
    evalCase.expected.status === "PASS" &&
    !metrics.planAfterReadiness
  ) {
    return "formal plan was not created after scoped readiness";
  }
  return null;
}
