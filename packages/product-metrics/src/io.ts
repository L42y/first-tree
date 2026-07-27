import { readFile } from "node:fs/promises";
import { optionalColumn, parseCsvDocument, requireCsvHeaders, requiredColumn } from "./csv.js";
import type { ActivityFact, AgentReadyMode, ClientReadyMode, UserJourneyFact, VisitorVisitFact } from "./types.js";

const JOURNEY_HEADERS = [
  "user_id",
  "account_authenticated_at",
  "client_ready_at",
  "client_ready_mode",
  "agent_ready_at",
  "agent_ready_mode",
  "bootstrap_received_at",
  "first_user_message_at",
] as const;
const ACTIVITY_HEADERS = ["user_id", "occurred_at", "message_count"] as const;
const VISIT_HEADERS = ["visitor_id", "visited_at", "is_first_visit", "user_id"] as const;

function clientMode(value: string | null): ClientReadyMode | null {
  if (value === null) return null;
  if (
    value === "connected" ||
    value === "observed_connected" ||
    value === "skipped" ||
    value === "inferred_completed"
  ) {
    return value;
  }
  throw new Error(`Invalid client_ready_mode: ${value}`);
}

function agentMode(value: string | null): AgentReadyMode | null {
  if (value === null) return null;
  if (value === "created" || value === "skipped" || value === "inferred_completed") return value;
  throw new Error(`Invalid agent_ready_mode: ${value}`);
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range`);
  return parsed;
}

function parseBoolean(value: string, label: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${label} must be true/false or 1/0`);
}

export async function loadJourneyCsv(filePath: string): Promise<UserJourneyFact[]> {
  const document = parseCsvDocument(await readFile(filePath, "utf8"));
  requireCsvHeaders(document.headers, JOURNEY_HEADERS, "journey");
  return document.rows.map((row) => ({
    userId: requiredColumn(row, "user_id"),
    accountAuthenticatedAt: optionalColumn(row, "account_authenticated_at"),
    clientReadyAt: optionalColumn(row, "client_ready_at"),
    clientReadyMode: clientMode(optionalColumn(row, "client_ready_mode")),
    agentReadyAt: optionalColumn(row, "agent_ready_at"),
    agentReadyMode: agentMode(optionalColumn(row, "agent_ready_mode")),
    bootstrapReceivedAt: optionalColumn(row, "bootstrap_received_at"),
    firstUserMessageAt: optionalColumn(row, "first_user_message_at"),
  }));
}

export async function loadActivityCsv(filePath: string): Promise<ActivityFact[]> {
  const document = parseCsvDocument(await readFile(filePath, "utf8"));
  requireCsvHeaders(document.headers, ACTIVITY_HEADERS, "activity");
  return document.rows.map((row) => ({
    userId: requiredColumn(row, "user_id"),
    occurredAt: requiredColumn(row, "occurred_at"),
    messageCount: parsePositiveInteger(requiredColumn(row, "message_count"), "message_count"),
  }));
}

export async function loadVisitCsv(filePath: string): Promise<VisitorVisitFact[]> {
  const document = parseCsvDocument(await readFile(filePath, "utf8"));
  requireCsvHeaders(document.headers, VISIT_HEADERS, "visit");
  return document.rows.map((row) => ({
    visitorId: requiredColumn(row, "visitor_id"),
    visitedAt: requiredColumn(row, "visited_at"),
    isFirstVisit: parseBoolean(requiredColumn(row, "is_first_visit"), "is_first_visit"),
    userId: optionalColumn(row, "user_id"),
  }));
}
