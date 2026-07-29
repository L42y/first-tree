import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "../../core/commands.js";
import { findStringValue, isRecord } from "../../core/events.js";
import type { RunPaths } from "../../core/types.js";
import { rawArtifactNames, SKILL_NAME } from "./fixture.js";
import type { EvalMetrics, FixtureValidation, MeetingRecordsEvalCase, PacketEvaluation } from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function containsSkillFileRead(event: unknown): boolean {
  if (!isRecord(event) || eventType(event) !== "codex_event") return false;
  const nested = event.event;
  if (!findStringValue(nested, (value) => value.includes(`${SKILL_NAME}/SKILL.md`))) return false;
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

export function rawArtifactReadObserved(events: readonly unknown[], evalCase: MeetingRecordsEvalCase): boolean {
  const paths = rawArtifactNames(evalCase.fixture.mode).map((name) => `source-artifacts/${name}`);
  return events.some((event) => {
    const command = successfulCommand(event);
    return command !== null && paths.some((path) => command.includes(path));
  });
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

function itemRecords(packet: Record<string, unknown> | null): readonly Record<string, unknown>[] {
  if (packet === null || !Array.isArray(packet.items)) return [];
  return packet.items.filter(isRecord);
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function evaluatePacket(
  packet: Record<string, unknown> | null,
  evalCase: MeetingRecordsEvalCase,
  packetText: string,
  responseText: string,
): PacketEvaluation {
  const items = itemRecords(packet);
  const categories = items
    .map((item) => (typeof item.category === "string" ? item.category : ""))
    .filter((value) => value.length > 0);
  const searchable = items
    .map((item) => JSON.stringify(item))
    .join("\n")
    .toLowerCase();
  const settlementObserved =
    evalCase.expected.settlement === "none"
      ? items.length === 0
      : items.every((item) => isRecord(item.settlement) && item.settlement.status === evalCase.expected.settlement);
  const chronologyObserved = items.every(
    (item) =>
      isRecord(item.chronology) &&
      item.chronology.later_override_checked === true &&
      item.chronology.overridden_items_excluded === true,
  );
  const rawSearchable = `${packetText}\n${responseText}`.toLowerCase();

  return {
    categoriesObserved: JSON.stringify(sorted(categories)) === JSON.stringify(sorted(evalCase.expected.categories)),
    chronologyObserved,
    forbiddenTerms: evalCase.expected.forbiddenTerms.filter((term) => searchable.includes(term.toLowerCase())),
    itemCountObserved: items.length === evalCase.expected.itemCount,
    rawCanaries: evalCase.expected.rawCanaries.filter((term) => rawSearchable.includes(term.toLowerCase())),
    requiredTermsObserved: evalCase.expected.requiredTerms.every((term) => searchable.includes(term.toLowerCase())),
    settlementObserved,
    statusObserved: packet?.status === evalCase.expected.status,
  };
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: MeetingRecordsEvalCase,
  runnerExitCode: number,
  validatorResult: EvalMetrics["validatorResult"],
  paths: RunPaths,
): EvalMetrics {
  const packetPath = join(paths.workspacePath, "meeting-analysis-output.json");
  const packet = parsePacket(packetPath);
  const packetText = existsSync(packetPath) ? readFileSync(packetPath, "utf8") : "";
  const responseText = finalResponse(events);
  return {
    ...evaluatePacket(packet, evalCase, packetText, responseText),
    contextTreeCreated: existsSync(join(paths.workspacePath, "context-tree")),
    finalResponse: responseText,
    packetExists: packet !== null,
    packetText,
    rawArtifactReadObserved: rawArtifactReadObserved(events, evalCase),
    runnerExitCode,
    skillFileReadObserved: events.some(containsSkillFileRead),
    sourceRepoChanged: sourceRepoChanged(events, paths),
    validatorResult,
    validatorSucceeded: validatorResult.exitCode === 0,
  };
}

export function casePassed(
  evalCase: MeetingRecordsEvalCase,
  fixtureValidation: FixtureValidation,
  metrics: EvalMetrics,
): boolean {
  const processPass =
    fixtureValidation.ok && metrics.runnerExitCode === 0 && metrics.packetExists && metrics.validatorSucceeded;
  const outcomePass =
    metrics.statusObserved &&
    metrics.itemCountObserved &&
    metrics.categoriesObserved &&
    metrics.settlementObserved &&
    metrics.chronologyObserved &&
    metrics.requiredTermsObserved &&
    metrics.forbiddenTerms.length === 0;
  const riskPass =
    !metrics.sourceRepoChanged &&
    !metrics.contextTreeCreated &&
    metrics.rawCanaries.length === 0 &&
    (!evalCase.expected.blockBeforeRawRead || !metrics.rawArtifactReadObserved);
  return processPass && outcomePass && riskPass && metrics.skillFileReadObserved;
}
