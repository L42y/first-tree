#!/usr/bin/env node
import path from "node:path";
import {
  assert,
  CANDIDATE_DISPOSITIONS,
  candidateId,
  claimHash,
  INPUT_SCHEMA,
  MEETING_DISPOSITIONS,
  normalizeClaimText,
  OUTPUT_SCHEMA,
  parseArgs,
  readJson,
  requireAbsolute,
  sha256,
  stableStringify,
  VALIDATED_SCHEMA,
  writeJsonAtomic,
} from "./lib.mjs";

const FORBIDDEN_KEYS = /(^|_)(transcript|raw|ai_notes?|open_id|provider_id|speaker_map)(_|$)/i;
const URL_PATTERN = /\bhttps?:\/\/\S+/i;
const SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|AKIA[A-Z0-9]{16})\b/;
const MONEY_PATTERN = /(?:[$¥€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:USD|CNY|RMB|EUR|GBP)\b)/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /(?:\+\d(?:[\s().-]*\d){7,14}\b|\b\d{3}[\s().-]\d{3}[\s.-]\d{4}\b|\b\d{11}\b)/;
const SETTLEMENT_STATUSES = new Set(["settled", "unsettled", "unknown"]);
const DEDUPE_STATUSES = new Set(["absent", "present", "proposed", "unknown"]);

const args = parseArgs(process.argv.slice(2));
assert(
  args.analysis_input && args.output,
  "Required: --analysis-input <analysis-input.json> --output <analysis-output.json>",
);

const inputPath = requireAbsolute(args.analysis_input, "--analysis-input");
const outputPath = requireAbsolute(args.output, "--output");
const input = readJson(inputPath);
const output = readJson(outputPath);
assert(input.schema === INPUT_SCHEMA, `unsupported analysis input schema: ${input.schema}`);
assert(output.schema === OUTPUT_SCHEMA, `unsupported analysis output schema: ${output.schema}`);
assertExactKeys(output, ["schema", "run_id", "tree_main_commit", "meeting_results"], "analysis output");
assert(output.run_id === input.run_id, "analysis output run_id does not match input");
assert(
  output.tree_main_commit === input.tree_main_commit,
  "analysis output tree_main_commit does not match the analyzed Tree snapshot",
);

function scanValue(value, keyPath = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scanValue(item, [...keyPath, String(index)]);
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assert(!FORBIDDEN_KEYS.test(key), `raw-shaped field is forbidden: ${[...keyPath, key].join(".")}`);
      scanValue(child, [...keyPath, key]);
    }
    return;
  }
  if (typeof value !== "string") return;
  assert(value.length <= 2000, `persisted string exceeds 2000 characters: ${keyPath.join(".")}`);
  assert(!URL_PATTERN.test(value), `URLs are forbidden in persisted packets: ${keyPath.join(".")}`);
  assert(!SECRET_PATTERN.test(value), `secret-like value is forbidden: ${keyPath.join(".")}`);
  assert(!MONEY_PATTERN.test(value), `unredacted amount-like value is forbidden: ${keyPath.join(".")}`);
  assert(!EMAIL_PATTERN.test(value), `email-like value is forbidden: ${keyPath.join(".")}`);
  assert(!PHONE_PATTERN.test(value), `phone-like value is forbidden: ${keyPath.join(".")}`);
  assert(!/\b(?:ou_|on_|oc_)[A-Za-z0-9_-]{8,}\b/.test(value), `provider identifier is forbidden: ${keyPath.join(".")}`);
}

function assertExactKeys(value, allowedKeys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${label} contains an unknown field: ${key}`);
  }
}

const inputMeetings = new Map(input.meetings.map((meeting) => [meeting.provider_meeting_id, meeting]));
const results = output.meeting_results ?? [];
assert(
  results.length === inputMeetings.size,
  "analysis output must contain exactly one result for every changed meeting",
);
const seenMeetings = new Set();
const normalizedResults = [];

for (const result of results) {
  assertExactKeys(result, ["meeting_id", "source_revision", "disposition", "reason", "candidates"], "meeting result");
  assert(typeof result.meeting_id === "string" && result.meeting_id, "meeting_result.meeting_id is required");
  assert(!seenMeetings.has(result.meeting_id), `duplicate meeting result: ${result.meeting_id}`);
  seenMeetings.add(result.meeting_id);
  const meeting = inputMeetings.get(result.meeting_id);
  assert(meeting, `unknown meeting result: ${result.meeting_id}`);
  assert(result.source_revision === meeting.source_revision, `stale source revision for meeting ${result.meeting_id}`);
  assert(MEETING_DISPOSITIONS.has(result.disposition), `invalid meeting disposition: ${result.disposition}`);
  assert(typeof result.reason === "string", "meeting result reason must be a string");

  const candidates = result.candidates ?? [];
  assert(Array.isArray(candidates), "meeting result candidates must be an array");
  if (meeting.source_status !== "complete" || meeting.chronology_complete !== true) {
    assert(
      result.disposition === "blocked-source" && candidates.length === 0,
      "incomplete source chronology requires a meeting-level blocked-source result",
    );
  }
  if (result.disposition === "candidates") assert(candidates.length > 0, "candidates disposition requires candidates");
  else assert(candidates.length === 0, `${result.disposition} meeting result cannot include candidates`);
  if (result.disposition !== "candidates") {
    assert(normalizeClaimText(result.reason).length >= 8, `${result.disposition} result requires a concrete reason`);
  }
  assert(normalizeClaimText(result.reason).length <= 600, "meeting result reason exceeds 600 characters");

  const normalizedCandidates = candidates.map((candidate) => {
    assertExactKeys(
      candidate,
      ["candidate_revision", "disposition", "claim", "target", "settlement", "chronology", "dedupe", "revisit_trigger"],
      "candidate",
    );
    assertExactKeys(candidate.claim, ["what", "why", "constraints"], "candidate.claim");
    assertExactKeys(candidate.target, ["path_hint"], "candidate.target");
    assertExactKeys(candidate.settlement, ["status", "evidence", "confirmation_member_ids"], "candidate.settlement");
    assertExactKeys(candidate.chronology, ["later_override_checked"], "candidate.chronology");
    assertExactKeys(candidate.dedupe, ["tree_main_checked", "open_proposals_checked", "status"], "candidate.dedupe");
    assert(
      CANDIDATE_DISPOSITIONS.has(candidate.disposition),
      `invalid candidate disposition: ${candidate.disposition}`,
    );
    if (["draft-eligible", "already-present", "already-proposed"].includes(candidate.disposition)) {
      assert(
        /^[0-9a-f]{40}$/.test(input.tree_main_commit),
        `${candidate.disposition} requires an exact Tree main commit`,
      );
    }
    assert(typeof candidate.claim.what === "string", "candidate claim.what must be a string");
    assert(typeof candidate.claim.why === "string", "candidate claim.why must be a string");
    assert(Array.isArray(candidate.claim.constraints), "candidate claim.constraints must be an array");
    assert(
      candidate.claim.constraints.every((constraint) => typeof constraint === "string"),
      "candidate claim.constraints must contain only strings",
    );
    assert(typeof candidate.target.path_hint === "string", "candidate target.path_hint must be a string");
    assert(
      typeof candidate.settlement.status === "string" && SETTLEMENT_STATUSES.has(candidate.settlement.status),
      "invalid settlement status",
    );
    assert(Array.isArray(candidate.settlement.evidence), "candidate settlement.evidence must be an array");
    assert(
      Array.isArray(candidate.settlement.confirmation_member_ids) &&
        candidate.settlement.confirmation_member_ids.every((memberId) => typeof memberId === "string"),
      "confirmation_member_ids must contain only strings",
    );
    assert(
      typeof candidate.chronology.later_override_checked === "boolean",
      "candidate chronology.later_override_checked must be a boolean",
    );
    assert(
      typeof candidate.dedupe.tree_main_checked === "boolean",
      "candidate dedupe.tree_main_checked must be a boolean",
    );
    assert(
      typeof candidate.dedupe.open_proposals_checked === "boolean",
      "candidate dedupe.open_proposals_checked must be a boolean",
    );
    assert(
      typeof candidate.dedupe.status === "string" && DEDUPE_STATUSES.has(candidate.dedupe.status),
      "invalid dedupe status",
    );
    assert(typeof candidate.revisit_trigger === "string", "candidate revisit_trigger must be a string");
    const what = normalizeClaimText(candidate.claim?.what);
    const why = normalizeClaimText(candidate.claim?.why);
    assert(what.length >= 12, "candidate claim.what is too short");
    assert(why.length >= 12, "candidate claim.why is too short");
    assert(what.length <= 1200, "candidate claim.what exceeds 1200 characters");
    assert(why.length <= 1200, "candidate claim.why exceeds 1200 characters");
    const constraints = (candidate.claim?.constraints ?? []).map(normalizeClaimText);
    assert(constraints.length <= 8, "candidate claim.constraints exceeds 8 items");
    for (const constraint of constraints) {
      assert(constraint.length > 0 && constraint.length <= 600, "candidate constraint must be 1 to 600 characters");
    }
    assert(
      Number.isInteger(candidate.candidate_revision) && candidate.candidate_revision >= 1,
      "candidate_revision must be a positive integer",
    );

    const evidence = candidate.settlement?.evidence ?? [];
    assert(
      evidence.length <= input.retention.max_evidence_items,
      `candidate exceeds max evidence items (${input.retention.max_evidence_items})`,
    );
    for (const item of evidence) {
      assertExactKeys(item, ["source_ref", "excerpt"], "candidate.settlement.evidence item");
      assert(typeof item.source_ref === "string" && item.source_ref, "evidence.source_ref is required");
      assert(typeof item.excerpt === "string" && item.excerpt.length > 0, "evidence.excerpt is required");
      assert(
        item.excerpt.length <= input.retention.max_excerpt_chars,
        `evidence excerpt exceeds ${input.retention.max_excerpt_chars} characters`,
      );
      assert(item.source_ref.length <= 200, "evidence.source_ref exceeds 200 characters");
    }
    const confirmationMemberIds = (candidate.settlement?.confirmation_member_ids ?? []).map(normalizeClaimText);
    assert(confirmationMemberIds.length <= 20, "confirmation_member_ids exceeds 20 items");
    assert(
      confirmationMemberIds.every((memberId) => memberId.length > 0 && memberId.length <= 120),
      "confirmation_member_ids contains an invalid member ID",
    );
    const targetHint = normalizeClaimText(candidate.target?.path_hint);
    assert(targetHint.length <= 240, "candidate target path hint exceeds 240 characters");
    assert(
      !path.isAbsolute(targetHint) && !targetHint.includes("..") && !targetHint.includes("\\"),
      "candidate target path hint must be a relative Tree path",
    );

    if (candidate.disposition === "draft-eligible") {
      assert(
        meeting.source_status === "complete" && meeting.chronology_complete === true,
        "draft-eligible requires complete source chronology",
      );
      assert(candidate.settlement?.status === "settled", "draft-eligible requires settled status");
      assert(candidate.chronology?.later_override_checked === true, "draft-eligible requires later override scan");
      assert(candidate.dedupe?.tree_main_checked === true, "draft-eligible requires Tree main dedupe");
      assert(candidate.dedupe?.open_proposals_checked === true, "draft-eligible requires open proposal dedupe");
      assert(candidate.dedupe?.status === "absent", "draft-eligible requires absent semantic duplicate");
      assert(
        typeof candidate.target?.path_hint === "string" && targetHint,
        "draft-eligible requires a target path hint",
      );
      assert(targetHint !== "NEW_TOP_LEVEL", "this skill cannot propose a new top-level Tree domain");
    }
    if (candidate.disposition === "already-present") {
      assert(candidate.dedupe.status === "present", "already-present requires present semantic duplicate");
    }
    if (candidate.disposition === "already-proposed") {
      assert(candidate.dedupe.status === "proposed", "already-proposed requires proposed semantic duplicate");
    }

    if (candidate.disposition === "revisit") {
      const revisitTrigger = normalizeClaimText(candidate.revisit_trigger);
      assert(revisitTrigger.length >= 8, "revisit requires a concrete re-evaluation trigger");
      assert(revisitTrigger.length <= 600, "revisit trigger exceeds 600 characters");
    } else {
      assert(
        normalizeClaimText(candidate.revisit_trigger) === "",
        "non-revisit candidate revisit_trigger must be empty",
      );
    }

    const hash = claimHash(candidate);
    const normalized = {
      candidate_revision: candidate.candidate_revision,
      disposition: candidate.disposition,
      candidate_id: candidateId(result.meeting_id, hash),
      claim_hash: hash,
      claim: {
        what,
        why,
        constraints,
      },
      target: {
        path_hint: targetHint,
      },
      settlement: {
        status: candidate.settlement?.status,
        evidence: evidence.map((item) => ({
          source_ref: normalizeClaimText(item.source_ref),
          excerpt: normalizeClaimText(item.excerpt),
        })),
        confirmation_member_ids: confirmationMemberIds,
      },
      chronology: {
        later_override_checked: candidate.chronology?.later_override_checked === true,
      },
      dedupe: {
        tree_main_checked: candidate.dedupe?.tree_main_checked === true,
        open_proposals_checked: candidate.dedupe?.open_proposals_checked === true,
        status: candidate.dedupe?.status,
      },
      revisit_trigger: normalizeClaimText(candidate.revisit_trigger),
    };
    scanValue(normalized);
    return normalized;
  });
  const candidateIds = normalizedCandidates.map((candidate) => candidate.candidate_id);
  assert(
    new Set(candidateIds).size === candidateIds.length,
    `duplicate coherent claim in meeting result: ${result.meeting_id}`,
  );

  normalizedResults.push({
    meeting_id: result.meeting_id,
    source_revision: result.source_revision,
    disposition: result.disposition,
    reason: normalizeClaimText(result.reason),
    candidates: normalizedCandidates,
  });
}

for (const meetingId of inputMeetings.keys()) {
  assert(seenMeetings.has(meetingId), `missing meeting result: ${meetingId}`);
}
const draftEligibleCount = normalizedResults.reduce(
  (sum, result) => sum + result.candidates.filter((candidate) => candidate.disposition === "draft-eligible").length,
  0,
);
const candidateCount = normalizedResults.reduce((sum, result) => sum + result.candidates.length, 0);
assert(
  candidateCount <= input.retention.max_review_candidates,
  `run exceeds max review candidates (${input.retention.max_review_candidates})`,
);

const validated = {
  schema: VALIDATED_SCHEMA,
  run_id: input.run_id,
  tree_main_commit: input.tree_main_commit,
  validated_at: new Date().toISOString(),
  meeting_results: normalizedResults,
};
scanValue(validated);
const validatedPath = path.join(path.dirname(inputPath), "validated-output.json");
writeJsonAtomic(validatedPath, validated);
const validationReceiptPath = path.join(path.dirname(inputPath), "validation-receipt.json");
writeJsonAtomic(validationReceiptPath, {
  schema: "return-meeting-context.validation-receipt.v1",
  run_id: input.run_id,
  validated_output_path: validatedPath,
  validated_sha256: sha256(stableStringify(validated)),
  validated_at: validated.validated_at,
});
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    validated_output_path: validatedPath,
    validation_receipt_path: validationReceiptPath,
    meeting_result_count: normalizedResults.length,
    candidate_count: candidateCount,
    draft_eligible_count: draftEligibleCount,
  })}\n`,
);
