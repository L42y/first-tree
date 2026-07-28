#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  authenticatedUserId,
  calendarEvents,
  eventEnd,
  eventStart,
  larkVersion,
  noteItems,
  ownedCalendarEvent,
  parseV1Page,
  parseV2Document,
  protectedRef,
  providerTime,
  runLark,
} from "./feishu-lib.mjs";
import {
  assert,
  CAPTURE_SCHEMA,
  CONFIG_SCHEMA,
  ensureDedicatedTempDir,
  normalizeIso,
  parseArgs,
  readJson,
  requireAbsolute,
  sha256,
  writeJsonAtomic,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
assert(
  args.config && args.start && args.end && args.run_key,
  "Required: --config <file> --start <ISO> --end <ISO> --run-key <key> [--tree-main-commit <sha>]",
);

const configPath = requireAbsolute(args.config, "--config");
const config = readJson(configPath);
assert(config.schema === CONFIG_SCHEMA, `unsupported config schema: ${config.schema}`);
assert(config.provider === "feishu", "collect-feishu requires config.provider=feishu");
assert(
  typeof config.owner?.provider_id === "string" && config.owner.provider_id,
  "config.owner.provider_id is required",
);
const cliPath = config.feishu?.cli_path || "lark-cli";
const providerProfile = config.feishu?.profile || "";
const start = normalizeIso(args.start, "--start");
const end = normalizeIso(args.end, "--end");
assert(start < end, "--start must be earlier than --end");
if (args.tree_main_commit) {
  assert(/^[0-9a-f]{40}$/.test(args.tree_main_commit), "--tree-main-commit must be a 40-hex commit");
}

const captureBase = ensureDedicatedTempDir("return-meeting-context-capture");
const captureRoot = fs.mkdtempSync(path.join(captureBase, "capture-"));
fs.chmodSync(captureRoot, 0o700);

function fetchTranscript(token) {
  try {
    const v2Envelope = runLark(
      cliPath,
      providerProfile,
      ["docs", "+fetch", "--api-version", "v2", "--doc", token, "--as", "user", "--format", "json"],
      "docs fetch v2",
    );
    const document = parseV2Document(v2Envelope);
    return {
      document_id: document.document_id,
      source_revision: document.revision_id ? `provider:${document.revision_id}` : `sha256:${sha256(document.content)}`,
      provider_revision_present: Boolean(document.revision_id),
      content: document.content,
    };
  } catch {
    let offset = 0;
    let combined = "";
    let documentId = "";
    for (let page = 0; page < 100; page += 1) {
      const envelope = runLark(
        cliPath,
        providerProfile,
        [
          "docs",
          "+fetch",
          "--api-version",
          "v1",
          "--doc",
          token,
          "--offset",
          String(offset),
          "--limit",
          "20000",
          "--as",
          "user",
          "--format",
          "json",
        ],
        "docs fetch v1",
      );
      const parsed = parseV1Page(envelope);
      if (!documentId) documentId = parsed.document_id;
      assert(!documentId || documentId === parsed.document_id, "docs v1 pagination changed document id");
      assert(parsed.offset === offset, "docs v1 pagination returned a non-contiguous offset");
      combined += parsed.content;
      offset += parsed.length;
      if (offset === parsed.total_length) {
        assert(combined.trim(), "docs v1 returned empty transcript");
        return {
          document_id: documentId,
          source_revision: `sha256:${sha256(combined)}`,
          provider_revision_present: false,
          content: combined,
        };
      }
      assert(offset < parsed.total_length && parsed.length > 0, "docs v1 pagination is incomplete or made no progress");
    }
    throw new Error("docs v1 pagination exceeded 100 pages");
  }
}

try {
  const version = larkVersion(cliPath);
  const authenticatedUser = runLark(
    cliPath,
    providerProfile,
    ["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user", "--format", "json"],
    "authenticated user identity",
  );
  assert(
    authenticatedUserId(authenticatedUser) === config.owner.provider_id,
    "configured owner does not match the authenticated lark profile",
  );
  const agenda = runLark(
    cliPath,
    providerProfile,
    ["calendar", "+agenda", "--start", start, "--end", end, "--as", "user", "--format", "json"],
    "calendar agenda",
  );

  const meetings = [];
  let blockedOwnedCount = 0;
  let fetchedTranscriptCount = 0;
  for (const event of calendarEvents(agenda)) {
    assert(event?.event_id, "calendar event lacks event_id");
    const stableEventRef = protectedRef("feishu-calendar-event", event.event_id);
    const owned = ownedCalendarEvent(event, config.owner.provider_id);
    const startedAt = normalizeIso(eventStart(event), "calendar event start");
    const endedAt = eventEnd(event) ? normalizeIso(eventEnd(event), "calendar event end") : null;

    if (!owned) {
      meetings.push({
        provider_meeting_id: stableEventRef,
        calendar_event_id: stableEventRef,
        owner_provider_id: event?.event_organizer?.user_id ?? null,
        started_at: startedAt,
        ended_at: endedAt,
        source_status: "complete",
        source_refs: [],
        segments: [],
      });
      continue;
    }

    const sourceRefs = [
      {
        kind: "calendar-event",
        id: stableEventRef,
        revision: null,
      },
    ];
    const segments = [];
    const seenTranscriptTokens = new Set();
    const seenDocumentIds = new Map();
    let sourceStatus = "complete";
    try {
      const notesEnvelope = runLark(
        cliPath,
        providerProfile,
        ["vc", "+notes", "--calendar-event-ids", event.event_id, "--as", "user", "--format", "json"],
        "vc notes by calendar event",
      );
      const notes = noteItems(notesEnvelope);
      if (notes.length === 0) sourceStatus = "partial";
      for (const note of notes) {
        if (
          note.error ||
          !note.calendar_event_id ||
          note.calendar_event_id !== event.event_id ||
          !note.meeting_id ||
          !note.verbatim_doc_token
        ) {
          sourceStatus = "partial";
          continue;
        }
        const token = String(note.verbatim_doc_token);
        if (seenTranscriptTokens.has(token)) {
          sourceStatus = "partial";
          continue;
        }
        seenTranscriptTokens.add(token);
        try {
          const transcript = fetchTranscript(token);
          const priorToken = seenDocumentIds.get(transcript.document_id);
          if (priorToken && priorToken !== token) {
            sourceStatus = "partial";
            continue;
          }
          seenDocumentIds.set(transcript.document_id, token);
          const tokenRef = protectedRef("feishu-transcript", token);
          const documentRef = protectedRef("feishu-document", transcript.document_id || token);
          const textFile = path.join(captureRoot, `${sha256(token).slice(0, 24)}.txt`);
          fs.writeFileSync(textFile, transcript.content, { mode: 0o600 });
          const noteTime = providerTime(note.create_time, startedAt, "meeting note create_time");
          segments.push({
            source_id: `${protectedRef("feishu-meeting", note.meeting_id)}:${documentRef}`,
            source_revision: transcript.source_revision,
            started_at: noteTime,
            ended_at: null,
            text_file: textFile,
          });
          sourceRefs.push({
            kind: "meeting-note",
            id: protectedRef("feishu-meeting-note", `${note.meeting_id}:${token}`),
            revision: transcript.source_revision,
            provider_revision_present: transcript.provider_revision_present,
          });
          sourceRefs.push({
            kind: "transcript-document",
            id: tokenRef,
            revision: transcript.source_revision,
            provider_revision_present: transcript.provider_revision_present,
          });
          fetchedTranscriptCount += 1;
        } catch {
          sourceStatus = "partial";
        }
      }
    } catch {
      sourceStatus = "partial";
    }
    if (sourceStatus !== "complete" || segments.length === 0) blockedOwnedCount += 1;
    meetings.push({
      provider_meeting_id: stableEventRef,
      calendar_event_id: stableEventRef,
      owner_provider_id: config.owner.provider_id,
      title_hint: String(event.summary ?? "").slice(0, 160),
      started_at: startedAt,
      ended_at: endedAt,
      source_status: segments.length > 0 ? sourceStatus : "partial",
      source_refs: sourceRefs,
      segments,
    });
  }

  const capture = {
    schema: CAPTURE_SCHEMA,
    profile: config.profile,
    provider: config.provider,
    captured_at: new Date().toISOString(),
    run_key: args.run_key,
    discovery_complete: true,
    discovery_watermark: {
      calendar_start: start,
      calendar_end: end,
    },
    tree_main_commit: args.tree_main_commit ?? null,
    adapter: {
      name: "lark-cli",
      version,
      owner_gate: "calendar.event_organizer.user_id",
      profile_owner_verified: true,
    },
    ephemeral_root: captureRoot,
    meetings,
  };
  const capturePath = path.join(captureRoot, "capture.json");
  writeJsonAtomic(capturePath, capture);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      capture_path: capturePath,
      owned_meeting_count: meetings.filter((meeting) => meeting.owner_provider_id === config.owner.provider_id).length,
      skipped_owner_count: meetings.filter((meeting) => meeting.owner_provider_id !== config.owner.provider_id).length,
      blocked_owned_count: blockedOwnedCount,
      fetched_transcript_count: fetchedTranscriptCount,
      adapter_version: version,
    })}\n`,
  );
} catch (error) {
  fs.rmSync(captureRoot, { recursive: true, force: true });
  throw error;
}
