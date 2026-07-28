#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  assert,
  assertLockOwned,
  INPUT_SCHEMA,
  parseArgs,
  readJson,
  readState,
  releaseLock,
  removeRunDir,
  requireAbsolute,
  STATE_SCHEMA,
  sha256,
  stableStringify,
  VALIDATED_SCHEMA,
  writeJsonAtomic,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
assert(
  args.analysis_input && args.validated_output,
  "Required: --analysis-input <analysis-input.json> --validated-output <validated-output.json>",
);
const inputPath = requireAbsolute(args.analysis_input, "--analysis-input");
const validatedPath = requireAbsolute(args.validated_output, "--validated-output");
const input = readJson(inputPath);
const validated = readJson(validatedPath);
assert(input.schema === INPUT_SCHEMA, `unsupported analysis input schema: ${input.schema}`);
assert(validated.schema === VALIDATED_SCHEMA, `unsupported validated output schema: ${validated.schema}`);
assert(input.run_id === validated.run_id, "validated output run_id does not match input");
assert(path.dirname(inputPath) === input.run_dir, "analysis input must live at the run root");
assert(path.dirname(validatedPath) === input.run_dir, "validated output must live at the run root");
const validationReceipt = readJson(path.join(input.run_dir, "validation-receipt.json"));
assert(
  validationReceipt.schema === "return-meeting-context.validation-receipt.v1",
  "validation receipt is missing or unsupported",
);
assert(validationReceipt.run_id === input.run_id, "validation receipt run_id does not match");
assert(validationReceipt.validated_output_path === validatedPath, "validation receipt points at a different output");
assert(
  validationReceipt.validated_sha256 === sha256(stableStringify(validated)),
  "validated output changed after deterministic validation",
);

const state = readState(input.state_path);
const blockedResults = (input.blocked_meetings ?? []).map((meeting) => ({
  meeting_id: meeting.provider_meeting_id,
  source_revision: meeting.source_revision,
  disposition: "blocked-source",
  reason: meeting.reason,
  candidates: [],
}));
const reportMeetingResults = [...validated.meeting_results, ...blockedResults];
const inputMeetings = [...input.meetings, ...(input.blocked_meetings ?? [])];
const report = {
  schema: "return-meeting-context.report.v1",
  run_id: input.run_id,
  profile: input.profile,
  provider: input.provider,
  finalized_at: new Date().toISOString(),
  tree_main_commit: input.tree_main_commit,
  meeting_results: reportMeetingResults,
};

let allResultsSafe = true;
for (const result of reportMeetingResults) {
  const meeting = inputMeetings.find((item) => item.provider_meeting_id === result.meeting_id);
  assert(meeting, `validated result has no input meeting: ${result.meeting_id}`);
  const safeToAdvance =
    meeting.source_status === "complete" &&
    meeting.chronology_complete === true &&
    (result.disposition === "no-change" ||
      (result.disposition === "candidates" &&
        result.candidates.every((candidate) => !["blocked-source", "failed"].includes(candidate.disposition))));
  if (!safeToAdvance) allResultsSafe = false;
  if (safeToAdvance) state.source_revisions[meeting.meeting_key] = meeting.source_revision;
  state.meeting_dispositions[meeting.meeting_key] = {
    source_revision: meeting.source_revision,
    disposition: result.disposition,
    finalized_at: report.finalized_at,
  };
  for (const candidate of result.candidates) {
    const priorCandidate = state.candidate_dispositions[candidate.candidate_id];
    if (priorCandidate && priorCandidate.source_revision !== meeting.source_revision) {
      assert(
        candidate.candidate_revision > priorCandidate.candidate_revision,
        `candidate revision must advance after source revision changes: ${candidate.candidate_id}`,
      );
    }
    state.candidate_dispositions[candidate.candidate_id] = {
      meeting_key: meeting.meeting_key,
      source_revision: meeting.source_revision,
      candidate_revision: candidate.candidate_revision,
      claim_hash: candidate.claim_hash,
      disposition: candidate.disposition,
      finalized_at: report.finalized_at,
    };
  }
}
const watermarkKey = `${input.provider}:${input.profile}`;
if (input.discovery_complete === true && allResultsSafe) {
  state.watermarks[watermarkKey] = {
    value: input.discovery_watermark,
    advanced_at: report.finalized_at,
    run_id: input.run_id,
  };
}
if (input.run_key) {
  state.processed_run_keys[input.run_key] = {
    finalized_at: report.finalized_at,
    discovery_complete: input.discovery_complete === true,
    all_results_safe: allResultsSafe,
  };
}
state.schema = STATE_SCHEMA;
state.updated_at = report.finalized_at;

const reportDir = path.join(path.dirname(input.state_path), "reports");
const reportPath = path.join(reportDir, `${input.run_id}.json`);
assertLockOwned(input.lock_path, input.run_id);
removeRunDir(input.run_dir, input.temp_root);
writeJsonAtomic(reportPath, report);
writeJsonAtomic(input.state_path, state);
releaseLock(input.lock_path, input.run_id);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    run_id: input.run_id,
    report_path: reportPath,
    raw_projection_removed: !fs.existsSync(input.run_dir),
    watermark_advanced: input.discovery_complete === true && allResultsSafe,
    advanced_meeting_count: reportMeetingResults.filter((result) => {
      const meeting = inputMeetings.find((item) => item.provider_meeting_id === result.meeting_id);
      if (!meeting || meeting.source_status !== "complete" || meeting.chronology_complete !== true) return false;
      if (result.disposition === "no-change") return true;
      return (
        result.disposition === "candidates" &&
        result.candidates.every((candidate) => !["blocked-source", "failed"].includes(candidate.disposition))
      );
    }).length,
  })}\n`,
);
