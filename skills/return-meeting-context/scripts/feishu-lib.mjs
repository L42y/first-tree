import { spawnSync } from "node:child_process";
import { assert, normalizeIso, sha256 } from "./lib.mjs";

export function parseCliJson(stdout, label) {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("{");
  assert(start >= 0, `${label} returned no JSON envelope`);
  const envelope = JSON.parse(text.slice(start));
  assert(envelope.ok === true, `${label} returned ok=false`);
  return envelope;
}

export function runLark(cliPath, profile, commandArgs, label) {
  const args = profile ? ["--profile", profile, ...commandArgs] : commandArgs;
  const result = spawnSync(cliPath, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  assert(result.status === 0, `${label} failed with exit status ${result.status ?? "unknown"}`);
  return parseCliJson(result.stdout, label);
}

export function larkVersion(cliPath) {
  const result = spawnSync(cliPath, ["--version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  assert(result.status === 0, "lark-cli --version failed");
  const match = String(result.stdout).match(/(\d+\.\d+\.\d+)/);
  assert(match, "lark-cli --version returned no semantic version");
  return match[1];
}

export function calendarEvents(envelope) {
  assert(Array.isArray(envelope.data), "calendar agenda data must be an array");
  return envelope.data;
}

export function noteItems(envelope) {
  const notes = envelope.data?.notes;
  assert(Array.isArray(notes), "vc notes data.notes must be an array");
  return notes;
}

export function authenticatedUserId(envelope) {
  const data = envelope.data?.data ?? envelope.data;
  assert(data && typeof data === "object", "authenticated user response lacks data");
  const identity = data.open_id ?? data.user_id;
  assert(typeof identity === "string" && identity, "authenticated user response lacks an immutable provider identity");
  return identity;
}

export function parseV2Document(envelope) {
  const document = envelope.data?.document;
  assert(document && typeof document === "object", "docs v2 response lacks data.document");
  assert(
    typeof document.content === "string" && document.content.trim(),
    "docs v2 response contains no document content",
  );
  assert(document.document_id, "docs v2 response lacks document_id");
  return {
    document_id: String(document.document_id),
    revision_id:
      document.revision_id === undefined || document.revision_id === null ? null : String(document.revision_id),
    content: document.content,
  };
}

export function parseV1Page(envelope) {
  const data = envelope.data;
  assert(data && typeof data === "object", "docs v1 response lacks data");
  assert(typeof data.markdown === "string", "docs v1 response lacks markdown");
  const offset = Number(data.offset);
  const length = Number(data.length);
  const totalLength = Number(data.total_length);
  assert(Number.isInteger(offset) && offset >= 0, "docs v1 offset is invalid");
  assert(Number.isInteger(length) && length >= 0, "docs v1 length is invalid");
  assert(Number.isInteger(totalLength) && totalLength >= 0, "docs v1 total_length is invalid");
  return {
    document_id: String(data.doc_id ?? ""),
    content: data.markdown,
    offset,
    length,
    total_length: totalLength,
  };
}

export function providerTime(value, fallback, label) {
  if (value === undefined || value === null || value === "") return normalizeIso(fallback, `${label} fallback`);
  if (/^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const milliseconds = String(value).length >= 13 ? numeric : numeric * 1000;
    return normalizeIso(milliseconds, label);
  }
  return normalizeIso(value, label);
}

export function protectedRef(kind, value) {
  assert(value !== undefined && value !== null && String(value), `${kind} source reference is missing`);
  return `${kind}:${sha256(String(value)).slice(0, 32)}`;
}

export function ownedCalendarEvent(event, ownerProviderId) {
  return event?.event_organizer?.user_id === ownerProviderId;
}

export function eventStart(event) {
  return event?.start_time?.datetime;
}

export function eventEnd(event) {
  return event?.end_time?.datetime;
}
