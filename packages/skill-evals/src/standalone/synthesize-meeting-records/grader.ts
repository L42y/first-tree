import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyShellCommandIo } from "@first-tree/shared";

import { runCommand } from "../../core/commands.js";
import { isRecord } from "../../core/events.js";
import type { RunPaths } from "../../core/types.js";
import { SKILL_NAME } from "./fixture.js";
import type { EvalMetrics, FixtureValidation, MeetingRecordsEvalCase, PacketEvaluation } from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];
const CONTENT_READ_COMMANDS = new Set(["cat", "grep", "head", "nl", "rg", "sed", "tail"]);

type ClaudeToolUse = {
  id: string;
  input: Record<string, unknown>;
  name: string;
};

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function codexEventPayload(event: unknown): Record<string, unknown> | null {
  if (!isRecord(event) || eventType(event) !== "codex_event" || !isRecord(event.event)) return null;
  return event.event;
}

function nativeFileReadPaths(event: unknown): readonly string[] {
  const payload = codexEventPayload(event);
  if (payload === null) return [];
  const item = payload.item;
  if (!isRecord(item) || (item.type !== "file_read" && item.type !== "read_file")) return [];
  const path = typeof item.path === "string" ? item.path : typeof item.file_path === "string" ? item.file_path : null;
  return path === null ? [] : [path];
}

function claudeContentBlocks(event: unknown, envelopeType: "assistant" | "user"): readonly Record<string, unknown>[] {
  const payload = codexEventPayload(event);
  if (payload === null || payload.type !== envelopeType || !isRecord(payload.message)) return [];
  const content = payload.message.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function claudeToolUses(events: readonly unknown[]): readonly ClaudeToolUse[] {
  const uses: ClaudeToolUse[] = [];
  for (const event of events) {
    for (const block of claudeContentBlocks(event, "assistant")) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        isRecord(block.input)
      ) {
        uses.push({ id: block.id, input: block.input, name: block.name });
      }
    }
  }
  return uses;
}

function successfulClaudeToolUseIds(events: readonly unknown[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    for (const block of claudeContentBlocks(event, "user")) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string" && block.is_error !== true) {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

function successfulClaudeToolUses(events: readonly unknown[]): readonly ClaudeToolUse[] {
  const successfulIds = successfulClaudeToolUseIds(events);
  return claudeToolUses(events).filter((use) => successfulIds.has(use.id));
}

function normalizedClaudeToolName(value: string): string {
  return value.split(/[:.]/u).at(-1)?.toLowerCase() ?? value.toLowerCase();
}

function claudeReadPath(use: ClaudeToolUse): string | null {
  if (normalizedClaudeToolName(use.name) !== "read") return null;
  return typeof use.input.file_path === "string"
    ? use.input.file_path
    : typeof use.input.path === "string"
      ? use.input.path
      : null;
}

function claudeBashCommand(use: ClaudeToolUse): string | null {
  if (normalizedClaudeToolName(use.name) !== "bash") return null;
  return typeof use.input.command === "string" ? use.input.command : null;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
}

function pathMatches(value: string, expected: string): boolean {
  const normalized = normalizedPath(value);
  return normalized === expected || normalized.endsWith(`/${expected}`);
}

function commandReadPaths(command: string): readonly string[] {
  const classification = classifyShellCommandIo(command);
  if (!classification.supported || !CONTENT_READ_COMMANDS.has(classification.commandName)) return [];
  return classification.pathArgs.filter((path) => path.pathKindHint !== "directory").map((path) => path.raw);
}

function isSkillPath(path: string): boolean {
  return (
    pathMatches(path, `.agents/skills/${SKILL_NAME}/SKILL.md`) ||
    pathMatches(path, `.claude/skills/${SKILL_NAME}/SKILL.md`)
  );
}

function commandReadsSkill(command: string): boolean {
  return commandReadPaths(command).some(isSkillPath);
}

function nativeSkillReadObserved(events: readonly unknown[]): boolean {
  return events.some((event) => nativeFileReadPaths(event).some(isSkillPath));
}

function successfulCodexCommands(events: readonly unknown[]): readonly string[] {
  return events.map(successfulCommand).filter((command): command is string => command !== null);
}

function successfulClaudeCommands(events: readonly unknown[]): readonly string[] {
  return successfulClaudeToolUses(events)
    .map(claudeBashCommand)
    .filter((command): command is string => command !== null);
}

function successfulClaudeReadPaths(events: readonly unknown[]): readonly string[] {
  return successfulClaudeToolUses(events)
    .map(claudeReadPath)
    .filter((path): path is string => path !== null);
}

function successfulCommand(event: unknown): string | null {
  const payload = codexEventPayload(event);
  if (payload === null) return null;
  const item = payload.item;
  if (!isRecord(item) || item.type !== "command_execution" || typeof item.command !== "string") return null;
  const exitCode =
    typeof item.exit_code === "number" ? item.exit_code : typeof item.exitCode === "number" ? item.exitCode : null;
  if (item.status !== "completed" || (exitCode !== null && exitCode !== 0)) return null;
  return item.command;
}

export function rawArtifactReadObserved(events: readonly unknown[], evalCase: MeetingRecordsEvalCase): boolean {
  if (!evalCase.expected.blockBeforeRawRead) return false;
  return events.some(
    (event) =>
      isRecord(event) && (event.type === "partial_raw_access_attempt" || event.type === "partial_raw_path_mutation"),
  );
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

function claudeAssistantText(event: unknown): readonly string[] {
  return claudeContentBlocks(event, "assistant")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
}

function assistantTexts(events: readonly unknown[]): readonly string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (!isRecord(event) || eventType(event) !== "codex_event") continue;
    texts.push(...collectText(event.event));
    texts.push(...claudeAssistantText(event));
  }
  return texts;
}

export function assistantVisibleText(events: readonly unknown[]): string {
  return assistantTexts(events).join("\n");
}

export function skillFileReadObserved(events: readonly unknown[]): boolean {
  return (
    nativeSkillReadObserved(events) ||
    successfulClaudeReadPaths(events).some(isSkillPath) ||
    [...successfulCodexCommands(events), ...successfulClaudeCommands(events)].some(commandReadsSkill)
  );
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
  const visibleAssistantText = assistantVisibleText(events);
  const finalResponse = assistantTexts(events).at(-1) ?? "";
  return {
    ...evaluatePacket(packet, evalCase, packetText, visibleAssistantText),
    contextTreeCreated: existsSync(join(paths.workspacePath, "context-tree")),
    finalResponse,
    packetExists: packet !== null,
    packetText,
    rawArtifactReadObserved: rawArtifactReadObserved(events, evalCase),
    runnerExitCode,
    skillFileReadObserved: skillFileReadObserved(events),
    sourceRepoChanged: sourceRepoChanged(events, paths),
    validatorResult,
    validatorSucceeded: validatorResult.exitCode === 0,
  };
}

export function casePassed(fixtureValidation: FixtureValidation, metrics: EvalMetrics): boolean {
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
    !metrics.rawArtifactReadObserved &&
    metrics.rawCanaries.length === 0;
  return processPass && outcomePass && riskPass && metrics.skillFileReadObserved;
}
