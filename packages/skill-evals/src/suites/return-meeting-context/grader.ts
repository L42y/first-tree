import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripShellCommandDisplayWrapper } from "@first-tree/shared";

import { runCommand } from "../../core/commands.js";
import { findStringValue, isRecord } from "../../core/events.js";
import { evidence, riskFlag } from "../../core/grading.js";
import { allScoresPass, type SkillCaseGrading, type SkillCaseScores } from "../../core/result-schema.js";
import type { RunPaths } from "../../core/types.js";
import type { EvalMetrics, FixtureValidation, ReturnMeetingContextEvalCase } from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];

export type RoutingObservation = {
  interpreterSkillReadOrder: number | null;
  routingOrderObserved: boolean;
  validatorInvocationOrder: number | null;
  writerSkillReadOrder: number | null;
};

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function containsSkillFileRead(event: unknown, skillName: string): boolean {
  if (!isRecord(event) || eventType(event) !== "codex_event") return false;
  const nested = event.event;
  if (!findStringValue(nested, (value) => value.includes(`${skillName}/SKILL.md`))) return false;
  const serialized = JSON.stringify(nested) ?? "";
  if (serialized.includes("Available Skills")) return false;
  return /tool|exec|command|cmd|read|cat|sed/iu.test(serialized);
}

function successfulCommand(event: unknown): string | null {
  if (!isRecord(event) || eventType(event) !== "codex_event" || !isRecord(event.event)) return null;
  const item = event.event.item;
  if (!isRecord(item) || item.type !== "command_execution" || typeof item.command !== "string") return null;
  const exitCode =
    typeof item.exit_code === "number" ? item.exit_code : typeof item.exitCode === "number" ? item.exitCode : null;
  if (item.status !== "completed" || (exitCode !== null && exitCode !== 0)) return null;
  return item.command;
}

function commandBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? normalized.toLowerCase();
}

function tokenizeStaticCommand(command: string): string[] | null {
  const unwrapped = stripShellCommandDisplayWrapper(command);
  if (unwrapped.trim().length === 0) return null;

  const tokens: string[] = [];
  let value = "";
  let quote: "'" | '"' | null = null;

  const flush = (): void => {
    if (value.length === 0) return;
    tokens.push(value);
    value = "";
  };

  for (let index = 0; index < unwrapped.length; index++) {
    const character = unwrapped[index];
    if (character === undefined) break;

    if (quote === "'") {
      if (character === "'") quote = null;
      else value += character;
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "\\") {
        const next = unwrapped[index + 1];
        if (next === undefined) return null;
        value += next;
        index++;
        continue;
      }
      if (character === "$" || character === "`") return null;
      value += character;
      continue;
    }

    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\") {
      const next = unwrapped[index + 1];
      if (next === undefined) return null;
      value += next;
      index++;
      continue;
    }
    if (
      character === "|" ||
      character === ";" ||
      character === "&" ||
      character === ">" ||
      character === "<" ||
      character === "\n" ||
      character === "\r" ||
      character === "$" ||
      character === "`"
    ) {
      return null;
    }
    value += character;
  }

  if (quote !== null) return null;
  flush();
  return tokens.length > 0 ? tokens : null;
}

function isStaticEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=[^$`]*$/u.test(value);
}

function isValidatorScriptPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//u, "");
  const suffix = "skills/return-meeting-context/scripts/validate-output.mjs";
  return normalized === suffix || normalized.endsWith(`/${suffix}`);
}

const SAFE_NODE_BOOLEAN_OPTIONS = new Set([
  "--enable-source-maps",
  "--experimental-strip-types",
  "--inspect",
  "--inspect-brk",
  "--no-deprecation",
  "--no-warnings",
  "--pending-deprecation",
  "--preserve-symlinks",
  "--preserve-symlinks-main",
  "--throw-deprecation",
  "--trace-deprecation",
  "--trace-warnings",
]);

function executesMeetingContextValidator(command: string): boolean {
  const tokens = tokenizeStaticCommand(command);
  if (tokens === null) return false;

  let index = 0;
  if (commandBasename(tokens[index] ?? "") === "exec") index++;

  if (commandBasename(tokens[index] ?? "") === "env") {
    index++;
    if (tokens[index] === "--") index++;
    while (isStaticEnvironmentAssignment(tokens[index] ?? "")) index++;
  }

  if (commandBasename(tokens[index] ?? "") !== "node") return false;
  index++;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) return false;
    if (token === "--") {
      index++;
      break;
    }
    if (!token.startsWith("-")) break;
    const option = token.split("=", 1)[0];
    if (
      option === "-c" ||
      option === "--check" ||
      option === "-e" ||
      option === "--eval" ||
      option === "-p" ||
      option === "--print" ||
      option === "--run" ||
      option === "--test"
    ) {
      return false;
    }
    if (!token.includes("=") && !SAFE_NODE_BOOLEAN_OPTIONS.has(token)) return false;
    index++;
  }

  const script = tokens[index];
  return script !== undefined && isValidatorScriptPath(script);
}

export function deriveRoutingObservation(
  events: readonly unknown[],
  evalCase: ReturnMeetingContextEvalCase,
): RoutingObservation {
  let interpreterSkillReadOrder: number | null = null;
  let validatorInvocationOrder: number | null = null;
  let writerSkillReadOrder: number | null = null;
  for (const [order, event] of events.entries()) {
    if (interpreterSkillReadOrder === null && containsSkillFileRead(event, "return-meeting-context")) {
      interpreterSkillReadOrder = order;
    }
    if (writerSkillReadOrder === null && containsSkillFileRead(event, "first-tree-write")) {
      writerSkillReadOrder = order;
    }
    const command = successfulCommand(event);
    if (validatorInvocationOrder === null && command !== null && executesMeetingContextValidator(command)) {
      validatorInvocationOrder = order;
    }
  }

  const routingOrderObserved =
    evalCase.fixture.routing === "meeting-vs-write"
      ? interpreterSkillReadOrder !== null &&
        validatorInvocationOrder !== null &&
        interpreterSkillReadOrder < validatorInvocationOrder &&
        (writerSkillReadOrder === null || validatorInvocationOrder < writerSkillReadOrder)
      : interpreterSkillReadOrder !== null;

  return {
    interpreterSkillReadOrder,
    routingOrderObserved,
    validatorInvocationOrder,
    writerSkillReadOrder,
  };
}

function isAssistantMessage(record: Record<string, unknown>): boolean {
  const type = eventType(record);
  const role = typeof record.role === "string" ? record.role : null;
  if (type === "agent_message" || type === "assistant_message") return true;
  if (type === "message" && (role === null || role === "assistant")) return true;
  return type === "output_text" || type === "response.output_text.done";
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectText);
  if (!isRecord(value)) return [];
  const texts: string[] = [];
  if (isAssistantMessage(value)) {
    for (const key of TEXT_KEYS) {
      const item = value[key];
      if (typeof item === "string") texts.push(item);
      if (Array.isArray(item)) texts.push(...item.flatMap(collectText));
    }
  }
  for (const key of ["item", "message", "response", "output"]) {
    const item = value[key];
    if (isRecord(item) || Array.isArray(item)) texts.push(...collectText(item));
  }
  return texts;
}

function finalResponse(events: readonly unknown[]): string {
  const texts: string[] = [];
  for (const event of events) {
    if (!isRecord(event) || eventType(event) !== "codex_event") continue;
    texts.push(...collectText(event.event));
  }
  return texts.at(-1) ?? "";
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
  const sourceRepoPath = join(paths.workspacePath, "source-artifacts");
  const baseline = sourceBaselineHead(events);
  if (!existsSync(sourceRepoPath) || baseline === null) return true;
  const status = runCommand("git", ["status", "--porcelain"], sourceRepoPath);
  const head = runCommand("git", ["rev-parse", "HEAD"], sourceRepoPath);
  return (
    status.exitCode !== 0 || status.stdout.trim().length > 0 || head.exitCode !== 0 || head.stdout.trim() !== baseline
  );
}

function parsePacket(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function candidateRecords(packet: Record<string, unknown> | null): readonly Record<string, unknown>[] {
  if (packet === null || !Array.isArray(packet.candidates)) return [];
  return packet.candidates.filter(isRecord);
}

function claimText(candidates: readonly Record<string, unknown>[]): string {
  return candidates
    .map((candidate) => (isRecord(candidate.claim) ? JSON.stringify(candidate.claim) : ""))
    .join("\n")
    .toLowerCase();
}

function settlementObserved(
  evalCase: ReturnMeetingContextEvalCase,
  candidates: readonly Record<string, unknown>[],
): boolean {
  if (evalCase.expected.settlement === "none") return candidates.length === 0;
  return candidates.every(
    (candidate) => isRecord(candidate.settlement) && candidate.settlement.status === evalCase.expected.settlement,
  );
}

function chronologyObserved(
  evalCase: ReturnMeetingContextEvalCase,
  candidates: readonly Record<string, unknown>[],
): boolean {
  if (evalCase.expected.status !== "ready-for-write") return true;
  return candidates.every(
    (candidate) =>
      isRecord(candidate.chronology) &&
      candidate.chronology.later_override_checked === true &&
      candidate.chronology.overridden_claims_excluded === true,
  );
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: ReturnMeetingContextEvalCase,
  fixtureValidation: FixtureValidation,
  runnerExitCode: number,
  validatorResult: EvalMetrics["validatorResult"],
  paths: RunPaths,
): EvalMetrics {
  void fixtureValidation;
  const packetPath = join(paths.workspacePath, "meeting-context-output.json");
  const packet = parsePacket(packetPath);
  const candidates = candidateRecords(packet);
  const claims = claimText(candidates);
  const forbiddenClaimTerms = evalCase.expected.forbiddenClaimTerms.filter((term) =>
    claims.includes(term.toLowerCase()),
  );
  const routing = deriveRoutingObservation(events, evalCase);
  return {
    candidateCountObserved: candidates.length === evalCase.expected.candidateCount,
    chronologyObserved: chronologyObserved(evalCase, candidates),
    contextTreeCreated: existsSync(join(paths.workspacePath, "context-tree")),
    finalResponse: finalResponse(events),
    forbiddenClaimTerms,
    handoffObserved: packet?.handoff === evalCase.expected.handoff,
    packetExists: packet !== null,
    packetText: packetPath && existsSync(packetPath) ? readFileSync(packetPath, "utf8") : "",
    requiredClaimTermsObserved: evalCase.expected.requiredClaimTerms.every((term) =>
      claims.includes(term.toLowerCase()),
    ),
    runnerExitCode,
    settlementObserved: settlementObserved(evalCase, candidates),
    interpreterSkillReadOrder: routing.interpreterSkillReadOrder,
    routingOrderObserved: routing.routingOrderObserved,
    skillFileReadObserved: routing.interpreterSkillReadOrder !== null,
    sourceRepoChanged: sourceRepoChanged(events, paths),
    statusObserved: packet?.status === evalCase.expected.status,
    validatorInvocationOrder: routing.validatorInvocationOrder,
    validatorResult,
    validatorSucceeded: validatorResult.exitCode === 0,
    writerSkillReadOrder: routing.writerSkillReadOrder,
  };
}

function scores(fixtureValidation: FixtureValidation, metrics: EvalMetrics): SkillCaseScores {
  return {
    outcome_pass:
      metrics.packetExists &&
      metrics.statusObserved &&
      metrics.candidateCountObserved &&
      metrics.handoffObserved &&
      metrics.requiredClaimTermsObserved &&
      metrics.forbiddenClaimTerms.length === 0 &&
      metrics.settlementObserved &&
      metrics.chronologyObserved,
    process_pass: fixtureValidation.ok && metrics.runnerExitCode === 0 && metrics.validatorSucceeded,
    risk_pass: !metrics.sourceRepoChanged && !metrics.contextTreeCreated,
    routing_pass: metrics.routingOrderObserved,
  };
}

export function casePassed(fixtureValidation: FixtureValidation, metrics: EvalMetrics): boolean {
  return allScoresPass(scores(fixtureValidation, metrics));
}

export function buildGrading(
  evalCase: ReturnMeetingContextEvalCase,
  fixtureValidation: FixtureValidation,
  metrics: EvalMetrics,
): SkillCaseGrading {
  const caseScores = scores(fixtureValidation, metrics);
  const riskFlags = [
    ...(metrics.sourceRepoChanged
      ? [riskFlag("source_artifact_changed", "The user-supplied source artifact fixture changed.")]
      : []),
    ...(metrics.contextTreeCreated
      ? [riskFlag("unexpected_tree_write", "The analysis-only eval created a Context Tree.")]
      : []),
    ...metrics.forbiddenClaimTerms.map((term) =>
      riskFlag("overridden_or_nondurable_claim", `Forbidden claim term survived: ${term}`),
    ),
  ];
  return {
    caseId: evalCase.id,
    evidence: [
      evidence(
        "routing_pass",
        `ordered=${String(metrics.routingOrderObserved)}; interpreter=${String(metrics.interpreterSkillReadOrder)}; validator=${String(metrics.validatorInvocationOrder)}; writer=${String(metrics.writerSkillReadOrder)}`,
      ),
      evidence(
        "process_pass",
        `fixture=${String(fixtureValidation.ok)}; runner=${metrics.runnerExitCode}; validator=${metrics.validatorResult.exitCode}`,
      ),
      evidence(
        "outcome_pass",
        `status=${String(metrics.statusObserved)}; candidates=${String(metrics.candidateCountObserved)}; handoff=${String(metrics.handoffObserved)}; settlement=${String(metrics.settlementObserved)}; chronology=${String(metrics.chronologyObserved)}`,
      ),
      evidence(
        "risk_pass",
        `source changed=${String(metrics.sourceRepoChanged)}; tree created=${String(metrics.contextTreeCreated)}; forbidden claims=${metrics.forbiddenClaimTerms.length}`,
      ),
    ],
    passed: allScoresPass(caseScores),
    riskFlags,
    scores: caseScores,
  };
}

export function driftNote(metrics: EvalMetrics): string | null {
  if (!metrics.routingOrderObserved) return "meeting interpreter and validated writer handoff order was not observed";
  if (!metrics.validatorSucceeded) return "decision packet failed deterministic validation";
  if (metrics.sourceRepoChanged) return "source artifact fixture changed";
  if (metrics.contextTreeCreated) return "analysis-only eval created a Context Tree";
  if (metrics.forbiddenClaimTerms.length > 0) return "overridden or non-durable material survived";
  return null;
}
