#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  acquireLock,
  assert,
  CAPTURE_SCHEMA,
  CONFIG_SCHEMA,
  ensureDedicatedTempDir,
  ensurePrivateStateDir,
  INPUT_SCHEMA,
  meetingKey,
  normalizeIso,
  parseArgs,
  readJson,
  readState,
  releaseLock,
  requireAbsolute,
  runTempRoot,
  safeStem,
  sha256,
  sourceRevision,
  stableStringify,
  within,
  writeJsonAtomic,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
assert(args.config && args.capture, "Required: --config <file> --capture <file> [--tmp-root <dir>]");

const configPath = fs.realpathSync(requireAbsolute(args.config, "--config"));
const capturePath = fs.realpathSync(requireAbsolute(args.capture, "--capture"));
const config = readJson(configPath);
const capture = readJson(capturePath);

function ephemeralCaptureRoot() {
  if (!capture.ephemeral_root) return null;
  const root = fs.realpathSync(requireAbsolute(capture.ephemeral_root, "capture.ephemeral_root"));
  const allowedBase = ensureDedicatedTempDir("return-meeting-context-capture");
  assert(
    within(allowedBase, root) && path.basename(root).startsWith("capture-"),
    "capture.ephemeral_root is outside the allowed temp root",
  );
  assert(within(root, capturePath), "ephemeral capture manifest must live beneath ephemeral_root");
  return root;
}

const captureRoot = ephemeralCaptureRoot();

assert(config.schema === CONFIG_SCHEMA, `unsupported config schema: ${config.schema}`);
assert(capture.schema === CAPTURE_SCHEMA, `unsupported capture schema: ${capture.schema}`);
assert(
  capture.tree_main_commit === null ||
    capture.tree_main_commit === undefined ||
    /^[0-9a-f]{40}$/.test(capture.tree_main_commit),
  "capture.tree_main_commit must be null or a 40-hex commit",
);
assert(config.profile === capture.profile, "capture profile does not match config profile");
assert(config.provider === capture.provider, "capture provider does not match config provider");
assert(typeof config.owner?.member_id === "string" && config.owner.member_id, "config.owner.member_id is required");
assert(
  typeof config.owner?.provider_id === "string" && config.owner.provider_id,
  "config.owner.provider_id is required",
);

const allowedRoots = (config.allowed_source_roots ?? []).map((root) =>
  fs.realpathSync(requireAbsolute(root, "allowed_source_roots item")),
);
assert(allowedRoots.length > 0, "config.allowed_source_roots must contain at least one absolute private source root");
const stateDir = ensurePrivateStateDir(config.state_dir);
const statePath = path.join(stateDir, "state.json");
const state = readState(statePath);
const runId = `${Date.now()}-${sha256(`${process.pid}:${capturePath}:${Date.now()}`).slice(0, 12)}`;
const tempRoot = runTempRoot(args.tmp_root);
fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
const runDir = fs.mkdtempSync(path.join(tempRoot, "run-"));
fs.chmodSync(runDir, 0o700);
let lockPath = null;

const changedMeetings = [];
const blockedMeetings = [];
const unchangedMeetings = [];
const skippedMeetings = [];

try {
  lockPath = acquireLock(stateDir, runId, { recoverStale: args.recover_stale_lock === true });
  for (const meeting of capture.meetings ?? []) {
    assert(
      typeof meeting.provider_meeting_id === "string" && meeting.provider_meeting_id,
      "meeting.provider_meeting_id is required",
    );
    const base = {
      provider_meeting_id: meeting.provider_meeting_id,
      calendar_event_id: meeting.calendar_event_id ?? null,
      started_at: normalizeIso(meeting.started_at, "meeting.started_at"),
      ended_at: meeting.ended_at ? normalizeIso(meeting.ended_at, "meeting.ended_at") : null,
    };

    if (meeting.owner_provider_id !== config.owner.provider_id) {
      skippedMeetings.push({
        ...base,
        reason: meeting.owner_provider_id ? "owner-mismatch" : "owner-unknown",
      });
      continue;
    }

    const rawSegments = [...(meeting.segments ?? [])];
    const chronologyComplete =
      meeting.source_status === "complete" &&
      rawSegments.length > 0 &&
      rawSegments.every(
        (segment) => segment.source_id && segment.source_revision && segment.started_at && segment.text_file,
      );
    const key = meetingKey(config.provider, config.profile, meeting.provider_meeting_id);
    if (!chronologyComplete) {
      const revision = sourceRevision(
        meeting,
        rawSegments.map((segment) => ({
          source_id_hash: sha256(String(segment.source_id ?? "")),
          source_revision: String(segment.source_revision ?? ""),
          started_at: String(segment.started_at ?? ""),
          content_sha256: null,
        })),
      );
      blockedMeetings.push({
        ...base,
        meeting_key: key,
        owner_member_id: config.owner.member_id,
        source_status: meeting.source_status ?? "failed",
        chronology_complete: false,
        source_revision: revision,
        reason: "Source chronology is incomplete; raw content was not opened.",
      });
      continue;
    }

    const orderedSegments = rawSegments
      .map((segment) => ({
        ...segment,
        started_at: normalizeIso(segment.started_at, "segment.started_at"),
        ended_at: segment.ended_at ? normalizeIso(segment.ended_at, "segment.ended_at") : null,
        text_file: fs.realpathSync(requireAbsolute(segment.text_file, "segment.text_file")),
      }))
      .sort(
        (left, right) =>
          left.started_at.localeCompare(right.started_at) ||
          String(left.source_id).localeCompare(String(right.source_id)),
      );

    const segmentContents = [];
    const segmentHashes = [];
    for (const segment of orderedSegments) {
      assert(
        allowedRoots.some((root) => within(root, segment.text_file)),
        `segment source is outside allowed_source_roots: ${segment.text_file}`,
      );
      const stat = fs.lstatSync(segment.text_file);
      assert(stat.isFile() && !stat.isSymbolicLink(), `segment source must be a regular file: ${segment.text_file}`);
      const content = fs.readFileSync(segment.text_file, "utf8");
      const contentHash = sha256(content);
      segmentContents.push({ segment, content });
      segmentHashes.push({
        source_id: segment.source_id,
        source_revision: segment.source_revision,
        started_at: segment.started_at,
        content_sha256: contentHash,
      });
    }

    const revision = sourceRevision(meeting, segmentHashes);
    if (state.source_revisions[key] === revision) {
      unchangedMeetings.push({ ...base, meeting_key: key, source_revision: revision });
      continue;
    }

    const projectionDir = path.join(runDir, "meetings");
    fs.mkdirSync(projectionDir, { recursive: true, mode: 0o700 });
    const projectionPath = path.join(projectionDir, `${safeStem(meeting.provider_meeting_id)}.txt`);
    const projection = segmentContents
      .map(({ segment, content }) =>
        [
          `--- segment ${segment.source_id} @ ${segment.started_at} revision ${segment.source_revision} ---`,
          content.trim(),
        ].join("\n"),
      )
      .join("\n\n");
    fs.writeFileSync(projectionPath, `${projection}\n`, { mode: 0o600 });

    changedMeetings.push({
      meeting_key: key,
      provider_meeting_id: meeting.provider_meeting_id,
      calendar_event_id: meeting.calendar_event_id ?? null,
      owner_member_id: config.owner.member_id,
      started_at: base.started_at,
      ended_at: base.ended_at,
      title_hint: String(meeting.title_hint ?? "").slice(0, 160),
      source_status: meeting.source_status,
      chronology_complete: chronologyComplete,
      source_revision: revision,
      source_refs: meeting.source_refs ?? [],
      segments: segmentHashes,
      transcript_path: projectionPath,
    });
  }

  const analysisInput = {
    schema: INPUT_SCHEMA,
    run_id: runId,
    profile: config.profile,
    provider: config.provider,
    captured_at: normalizeIso(capture.captured_at, "capture.captured_at"),
    run_key: capture.run_key ?? null,
    discovery_complete: capture.discovery_complete === true,
    discovery_watermark: capture.discovery_watermark ?? null,
    tree_main_commit: capture.tree_main_commit ?? null,
    run_dir: runDir,
    temp_root: tempRoot,
    state_path: statePath,
    lock_path: lockPath,
    retention: {
      raw_lifetime: "run",
      max_excerpt_chars: Number(config.retention?.max_excerpt_chars ?? 600),
      max_evidence_items: Number(config.retention?.max_evidence_items ?? 3),
      max_review_candidates: Number(config.review?.max_candidates_per_run ?? 3),
    },
    meetings: changedMeetings,
    blocked_meetings: blockedMeetings,
    unchanged_meetings: unchangedMeetings,
    skipped_meetings: skippedMeetings,
  };
  const analysisInputPath = path.join(runDir, "analysis-input.json");
  writeJsonAtomic(analysisInputPath, analysisInput);
  writeJsonAtomic(path.join(runDir, "run-manifest.json"), {
    schema: "return-meeting-context.run-manifest.v1",
    run_id: runId,
    capture_sha256: sha256(stableStringify(capture)),
    config_profile: config.profile,
    created_at: new Date().toISOString(),
  });
  if (captureRoot) fs.rmSync(captureRoot, { recursive: true, force: true });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      run_id: runId,
      changed_meeting_count: changedMeetings.length,
      blocked_meeting_count: blockedMeetings.length,
      unchanged_meeting_count: unchangedMeetings.length,
      skipped_meeting_count: skippedMeetings.length,
      analysis_input_path: analysisInputPath,
      run_dir: runDir,
    })}\n`,
  );
} catch (error) {
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
    if (captureRoot) fs.rmSync(captureRoot, { recursive: true, force: true });
    if (lockPath) releaseLock(lockPath, runId);
  } catch {
    // Preserve the original error.
  }
  throw error;
}
