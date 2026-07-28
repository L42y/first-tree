#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calendarEvents, noteItems, parseCliJson, parseV1Page, parseV2Document, protectedRef } from "./feishu-lib.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "return-meeting-context-test-"));
const sourceRoot = path.join(testRoot, "private-source");
const stateDir = path.join(testRoot, "private-state");
const tempRoot = path.join(testRoot, "return-meeting-context");
fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function run(script, args, { expectFailure = false, env = {} } = {}) {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (expectFailure) {
    assert.notEqual(result.status, 0, `${script} unexpectedly succeeded`);
    return `${result.stderr}\n${result.stdout}`;
  }
  assert.equal(result.status, 0, `${script} failed:\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

function validCandidate() {
  return {
    candidate_revision: 1,
    disposition: "draft-eligible",
    claim: {
      what: "Meeting context returns only an approved durable conclusion.",
      why: "Raw work records remain outside shared organizational truth.",
      constraints: ["Human confirmation binds the exact candidate revision."],
    },
    target: {
      path_hint: "product/work-model/context-return.md",
    },
    settlement: {
      status: "settled",
      evidence: [
        {
          source_ref: "segment:typed-reference",
          excerpt: "<redacted-speaker> explicitly confirms the durable boundary.",
        },
      ],
      confirmation_member_ids: ["tree-member-id"],
    },
    chronology: {
      later_override_checked: true,
    },
    dedupe: {
      tree_main_checked: true,
      open_proposals_checked: true,
      status: "absent",
    },
    revisit_trigger: "",
  };
}

function analysisOutput(input, overrides = {}) {
  return {
    schema: "return-meeting-context.analysis-output.v1",
    run_id: input.run_id,
    tree_main_commit: input.tree_main_commit,
    meeting_results: input.meetings.map((meeting) => ({
      meeting_id: meeting.provider_meeting_id,
      source_revision: meeting.source_revision,
      disposition: "candidates",
      reason: "A settled durable decision survives the complete chronology.",
      candidates: [validCandidate()],
    })),
    ...overrides,
  };
}

try {
  assert.equal(calendarEvents({ data: [{ event_id: "typed-event" }] })[0].event_id, "typed-event");
  assert.equal(noteItems({ data: { notes: [{ meeting_id: "typed-meeting" }] } })[0].meeting_id, "typed-meeting");
  assert.deepEqual(
    parseV2Document({
      data: { document: { document_id: "typed-document", revision_id: 3, content: "private content" } },
    }),
    {
      document_id: "typed-document",
      revision_id: "3",
      content: "private content",
    },
  );
  assert.equal(
    parseV1Page({
      data: { doc_id: "typed-document", markdown: "page", offset: 0, length: 4, total_length: 4 },
    }).total_length,
    4,
  );
  assert.throws(() => parseCliJson('{"ok":false}', "fixture"), /ok=false/);
  assert.match(protectedRef("typed", "private-provider-id"), /^typed:[0-9a-f]{32}$/);

  const earlier = path.join(sourceRoot, "segment-earlier.txt");
  const later = path.join(sourceRoot, "segment-later.txt");
  fs.writeFileSync(earlier, "Earlier settled discussion.\n", { mode: 0o600 });
  fs.writeFileSync(later, "Later confirmation with no override.\n", { mode: 0o600 });

  const configPath = path.join(testRoot, "config.json");
  const capturePath = path.join(testRoot, "capture.json");
  writeJson(configPath, {
    schema: "return-meeting-context.config.v1",
    profile: "pilot",
    provider: "feishu",
    owner: {
      member_id: "tree-member-id",
      provider_id: "provider-owner-placeholder",
    },
    state_dir: stateDir,
    allowed_source_roots: [sourceRoot],
    discovery: {
      bootstrap_start: "2026-07-01T00:00:00.000Z",
      overlap_seconds: 300,
    },
    retention: {
      max_excerpt_chars: 120,
      max_evidence_items: 2,
    },
    review: {
      max_candidates_per_run: 3,
    },
  });
  const capture = {
    schema: "return-meeting-context.capture.v1",
    profile: "pilot",
    provider: "feishu",
    captured_at: "2026-07-28T08:00:00.000Z",
    run_key: "manual-run-1",
    discovery_complete: true,
    discovery_watermark: {
      calendar_end: "2026-07-28T08:00:00.000Z",
    },
    tree_main_commit: "252b0fb25e52c127cd43ba4b8aa036c943ee5a56",
    meetings: [
      {
        provider_meeting_id: "owned-meeting",
        calendar_event_id: "calendar-instance-placeholder",
        owner_provider_id: "provider-owner-placeholder",
        title_hint: "Owned meeting",
        started_at: "2026-07-28T02:00:00.000Z",
        ended_at: "2026-07-28T03:12:00.000Z",
        source_status: "complete",
        source_refs: [{ kind: "calendar-event", id: "typed-calendar-ref", revision: "r1" }],
        segments: [
          {
            source_id: "later",
            source_revision: "r2",
            started_at: "2026-07-28T03:00:00.000Z",
            text_file: later,
          },
          {
            source_id: "earlier",
            source_revision: "r1",
            started_at: "2026-07-28T02:00:00.000Z",
            text_file: earlier,
          },
        ],
      },
      {
        provider_meeting_id: "other-owner",
        owner_provider_id: "different-owner-placeholder",
        started_at: "2026-07-28T04:00:00.000Z",
        source_status: "complete",
        segments: [
          {
            source_id: "must-not-open",
            source_revision: "r1",
            started_at: "2026-07-28T04:00:00.000Z",
            text_file: path.join(sourceRoot, "does-not-exist.txt"),
          },
        ],
      },
      {
        provider_meeting_id: "unknown-owner",
        started_at: "2026-07-28T05:00:00.000Z",
        source_status: "complete",
        segments: [],
      },
    ],
  };
  writeJson(capturePath, capture);

  const invalidTempError = run(
    "prepare-run.mjs",
    ["--config", configPath, "--capture", capturePath, "--tmp-root", path.join(scriptsDir, "not-an-os-temp-root")],
    { expectFailure: true },
  );
  assert.match(invalidTempError, /must use a dedicated return-meeting-context name/);
  assert.equal(fs.existsSync(path.join(stateDir, "run.lock.json")), false);

  if (process.platform !== "win32") {
    const systemTempModeBefore = fs.statSync(fs.realpathSync(os.tmpdir())).mode & 0o777;
    const systemTempError = run(
      "prepare-run.mjs",
      ["--config", configPath, "--capture", capturePath, "--tmp-root", os.tmpdir()],
      { expectFailure: true },
    );
    assert.match(systemTempError, /must use a dedicated return-meeting-context name|strictly beneath/);
    assert.equal(fs.statSync(fs.realpathSync(os.tmpdir())).mode & 0o777, systemTempModeBefore);

    const sharedTempRoot = path.join(testRoot, "return-meeting-context-shared");
    fs.mkdirSync(sharedTempRoot, { mode: 0o755 });
    fs.chmodSync(sharedTempRoot, 0o755);
    const sharedTempError = run(
      "prepare-run.mjs",
      ["--config", configPath, "--capture", capturePath, "--tmp-root", sharedTempRoot],
      { expectFailure: true },
    );
    assert.match(sharedTempError, /must not be accessible by group or others/);
    assert.equal(fs.statSync(sharedTempRoot).mode & 0o777, 0o755);

    const symlinkTarget = path.join(testRoot, "return-meeting-context-target");
    const symlinkTempRoot = path.join(testRoot, "return-meeting-context-link");
    fs.mkdirSync(symlinkTarget, { mode: 0o700 });
    fs.symlinkSync(symlinkTarget, symlinkTempRoot, "dir");
    const symlinkTempError = run(
      "prepare-run.mjs",
      ["--config", configPath, "--capture", capturePath, "--tmp-root", symlinkTempRoot],
      { expectFailure: true },
    );
    assert.match(symlinkTempError, /must be a real directory/);
    assert.equal(fs.existsSync(path.join(stateDir, "run.lock.json")), false);

    const outsideRoot = path.join(testRoot, "outside-source-root");
    fs.mkdirSync(outsideRoot, { recursive: true, mode: 0o700 });
    const outsideFile = path.join(outsideRoot, "outside.txt");
    fs.writeFileSync(outsideFile, "Must not be read through a parent symlink.\n", { mode: 0o600 });
    const escapeLink = path.join(sourceRoot, "escape-link");
    fs.symlinkSync(outsideRoot, escapeLink, "dir");
    const escapeCapture = structuredClone(capture);
    escapeCapture.meetings = [structuredClone(capture.meetings[0])];
    escapeCapture.meetings[0].provider_meeting_id = "symlink-escape-meeting";
    escapeCapture.meetings[0].segments = [
      {
        source_id: "escape-segment",
        source_revision: "provider:escape",
        started_at: "2026-07-28T02:00:00.000Z",
        text_file: path.join(escapeLink, "outside.txt"),
      },
    ];
    const escapeCapturePath = path.join(testRoot, "escape-capture.json");
    writeJson(escapeCapturePath, escapeCapture);
    const escapeError = run(
      "prepare-run.mjs",
      ["--config", configPath, "--capture", escapeCapturePath, "--tmp-root", tempRoot],
      { expectFailure: true },
    );
    assert.match(escapeError, /outside allowed_source_roots/);
    assert.equal(fs.existsSync(path.join(stateDir, "run.lock.json")), false);
  }

  const prepared = run("prepare-run.mjs", ["--config", configPath, "--capture", capturePath, "--tmp-root", tempRoot]);
  assert.equal(prepared.changed_meeting_count, 1);
  assert.equal(prepared.skipped_meeting_count, 2);
  const input = JSON.parse(fs.readFileSync(prepared.analysis_input_path, "utf8"));
  const projection = fs.readFileSync(input.meetings[0].transcript_path, "utf8");
  assert.ok(projection.indexOf("Earlier settled discussion.") < projection.indexOf("Later confirmation"));
  assert.equal(fs.statSync(input.meetings[0].transcript_path).mode & 0o777, 0o600);

  const outputPath = path.join(prepared.run_dir, "analysis-output.json");
  const completeOutput = analysisOutput(input);
  const completeFailureCases = [
    {
      name: "unknown content field",
      mutate(output) {
        output.meeting_results[0].candidates[0].content = "forbidden";
        return output;
      },
      expected: /unknown field: content/,
    },
    {
      name: "raw-shaped field",
      mutate(output) {
        output.meeting_results[0].candidates[0].raw_transcript = "forbidden";
        return output;
      },
      expected: /unknown field: raw_transcript/,
    },
    {
      name: "oversized excerpt",
      mutate(output) {
        output.meeting_results[0].candidates[0].settlement.evidence[0].excerpt = "x".repeat(121);
        return output;
      },
      expected: /exceeds 120/,
    },
    {
      name: "private URL",
      mutate(output) {
        output.meeting_results[0].candidates[0].claim.why =
          "The private source URL must not persist: https://private.example.test.";
        return output;
      },
      expected: /URLs are forbidden/,
    },
    {
      name: "private email",
      mutate(output) {
        output.meeting_results[0].candidates[0].claim.why =
          "A private address such as person@example.test must not persist.";
        return output;
      },
      expected: /email-like value is forbidden/,
    },
    {
      name: "stale revision",
      mutate(output) {
        output.meeting_results[0].source_revision = "stale";
        return output;
      },
      expected: /stale source revision/,
    },
    {
      name: "invalid settlement value shape",
      mutate(output) {
        output.meeting_results[0].candidates[0].settlement.status = { content: "raw-shaped-value" };
        return output;
      },
      expected: /invalid settlement status/,
    },
    {
      name: "invalid dedupe value shape",
      mutate(output) {
        output.meeting_results[0].candidates[0].dedupe.status = { content: "raw-shaped-value" };
        return output;
      },
      expected: /invalid dedupe status/,
    },
    {
      name: "non revisit trigger",
      mutate(output) {
        output.meeting_results[0].candidates[0].revisit_trigger = "Private source prose must not persist here.";
        return output;
      },
      expected: /non-revisit candidate revisit_trigger must be empty/,
    },
  ];
  for (const failure of completeFailureCases) {
    const badOutputPath = path.join(prepared.run_dir, `bad-${failure.name.replaceAll(" ", "-")}.json`);
    const badOutput = failure.mutate(structuredClone(completeOutput));
    writeJson(badOutputPath, badOutput);
    const error = run(
      "validate-output.mjs",
      ["--analysis-input", prepared.analysis_input_path, "--output", badOutputPath],
      { expectFailure: true },
    );
    assert.match(error, failure.expected, `unexpected validation error for ${failure.name}`);
  }
  const missingResultPath = path.join(prepared.run_dir, "bad-missing-result.json");
  writeJson(missingResultPath, analysisOutput(input, { meeting_results: [] }));
  const missingError = run(
    "validate-output.mjs",
    ["--analysis-input", prepared.analysis_input_path, "--output", missingResultPath],
    { expectFailure: true },
  );
  assert.match(missingError, /exactly one result/);

  const noTreeInput = structuredClone(input);
  noTreeInput.tree_main_commit = null;
  const noTreeInputPath = path.join(prepared.run_dir, "analysis-input-no-tree.json");
  writeJson(noTreeInputPath, noTreeInput);
  const noTreeOutput = analysisOutput(noTreeInput);
  const noTreeOutputPath = path.join(prepared.run_dir, "analysis-output-no-tree.json");
  writeJson(noTreeOutputPath, noTreeOutput);
  const noTreeError = run("validate-output.mjs", ["--analysis-input", noTreeInputPath, "--output", noTreeOutputPath], {
    expectFailure: true,
  });
  assert.match(noTreeError, /requires an exact Tree main commit/);

  writeJson(outputPath, completeOutput);
  const validated = run("validate-output.mjs", [
    "--analysis-input",
    prepared.analysis_input_path,
    "--output",
    outputPath,
  ]);
  assert.equal(validated.candidate_count, 1);
  assert.equal(validated.draft_eligible_count, 1);
  const validatedBody = JSON.parse(fs.readFileSync(validated.validated_output_path, "utf8"));
  assert.match(validatedBody.meeting_results[0].candidates[0].candidate_id, /^meeting-owned-meeting-/);
  assert.match(validatedBody.meeting_results[0].candidates[0].claim_hash, /^[0-9a-f]{64}$/);

  const finalized = run("finalize-run.mjs", [
    "--analysis-input",
    prepared.analysis_input_path,
    "--validated-output",
    validated.validated_output_path,
  ]);
  assert.equal(finalized.raw_projection_removed, true);
  assert.equal(fs.existsSync(prepared.run_dir), false);
  const stateAfterFirst = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(Object.keys(stateAfterFirst.source_revisions).length, 1);
  assert.equal(stateAfterFirst.watermarks["feishu:pilot"].run_id, input.run_id);
  assert.equal(stateAfterFirst.processed_run_keys["manual-run-1"].all_results_safe, true);
  const firstRevision = Object.values(stateAfterFirst.source_revisions)[0];
  const plannedWindow = run("plan-window.mjs", ["--config", configPath, "--end", "2026-07-28T09:00:00.000Z"]);
  assert.equal(plannedWindow.source, "watermark");
  assert.equal(plannedWindow.start, "2026-07-28T07:55:00.000Z");
  assert.equal(plannedWindow.end, "2026-07-28T09:00:00.000Z");
  const firstCandidate = validatedBody.meeting_results[0].candidates[0];
  const firstCandidateState = stateAfterFirst.candidate_dispositions[firstCandidate.candidate_id];
  assert.equal(firstCandidateState.disposition, "draft-eligible");
  assert.equal("confirmation_status" in firstCandidateState, false);

  const unchanged = run("prepare-run.mjs", ["--config", configPath, "--capture", capturePath, "--tmp-root", tempRoot]);
  assert.equal(unchanged.changed_meeting_count, 0);
  assert.equal(unchanged.unchanged_meeting_count, 1);
  const unchangedInput = JSON.parse(fs.readFileSync(unchanged.analysis_input_path, "utf8"));
  const unchangedOutputPath = path.join(unchanged.run_dir, "analysis-output.json");
  writeJson(unchangedOutputPath, analysisOutput(unchangedInput));
  const unchangedValidated = run("validate-output.mjs", [
    "--analysis-input",
    unchanged.analysis_input_path,
    "--output",
    unchangedOutputPath,
  ]);
  assert.equal(unchangedValidated.candidate_count, 0);
  run("finalize-run.mjs", [
    "--analysis-input",
    unchanged.analysis_input_path,
    "--validated-output",
    unchangedValidated.validated_output_path,
  ]);

  fs.writeFileSync(later, "Later confirmation changed at the source.\n", { mode: 0o600 });
  const changed = run("prepare-run.mjs", ["--config", configPath, "--capture", capturePath, "--tmp-root", tempRoot]);
  assert.equal(changed.changed_meeting_count, 1);
  const changedInput = JSON.parse(fs.readFileSync(changed.analysis_input_path, "utf8"));
  assert.notEqual(changedInput.meetings[0].source_revision, firstRevision);
  const lockedError = run(
    "prepare-run.mjs",
    ["--config", configPath, "--capture", capturePath, "--tmp-root", tempRoot],
    { expectFailure: true },
  );
  assert.match(lockedError, /another run is active or needs explicit stale-lock recovery/);
  const changedOutputPath = path.join(changed.run_dir, "changed-output.json");
  writeJson(changedOutputPath, analysisOutput(changedInput));
  const changedValidated = run("validate-output.mjs", [
    "--analysis-input",
    changed.analysis_input_path,
    "--output",
    changedOutputPath,
  ]);
  const staleCandidateRevisionError = run(
    "finalize-run.mjs",
    ["--analysis-input", changed.analysis_input_path, "--validated-output", changedValidated.validated_output_path],
    { expectFailure: true },
  );
  assert.match(staleCandidateRevisionError, /candidate revision must advance after source revision changes/);
  run("abort-run.mjs", ["--analysis-input", changed.analysis_input_path]);
  const stateAfterAbort = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(stateAfterAbort.source_revisions)[0], firstRevision);
  const watermarkBeforePartialRunId = stateAfterAbort.watermarks["feishu:pilot"].run_id;

  const partialCapturePath = path.join(testRoot, "partial-capture.json");
  const partialCapture = structuredClone(capture);
  partialCapture.meetings = [structuredClone(capture.meetings[0])];
  partialCapture.meetings[0].provider_meeting_id = "partial-meeting";
  partialCapture.meetings[0].source_status = "partial";
  partialCapture.meetings[0].segments = [partialCapture.meetings[0].segments[0]];
  writeJson(partialCapturePath, partialCapture);
  const partial = run("prepare-run.mjs", [
    "--config",
    configPath,
    "--capture",
    partialCapturePath,
    "--tmp-root",
    tempRoot,
  ]);
  const partialInput = JSON.parse(fs.readFileSync(partial.analysis_input_path, "utf8"));
  assert.equal(partial.changed_meeting_count, 0);
  assert.equal(partial.blocked_meeting_count, 1);
  assert.equal(partialInput.meetings.length, 0);
  assert.equal(partialInput.blocked_meetings.length, 1);
  assert.equal("transcript_path" in partialInput.blocked_meetings[0], false);
  const blockedOutput = analysisOutput(partialInput);
  const blockedOutputPath = path.join(partial.run_dir, "blocked-output.json");
  writeJson(blockedOutputPath, blockedOutput);
  const blockedValidated = run("validate-output.mjs", [
    "--analysis-input",
    partial.analysis_input_path,
    "--output",
    blockedOutputPath,
  ]);
  const tampered = JSON.parse(fs.readFileSync(blockedValidated.validated_output_path, "utf8"));
  tampered.meeting_results.push({});
  writeJson(blockedValidated.validated_output_path, tampered);
  const tamperError = run(
    "finalize-run.mjs",
    ["--analysis-input", partial.analysis_input_path, "--validated-output", blockedValidated.validated_output_path],
    { expectFailure: true },
  );
  assert.match(tamperError, /changed after deterministic validation/);
  const revalidatedBlocked = run("validate-output.mjs", [
    "--analysis-input",
    partial.analysis_input_path,
    "--output",
    blockedOutputPath,
  ]);
  const partialFinalized = run("finalize-run.mjs", [
    "--analysis-input",
    partial.analysis_input_path,
    "--validated-output",
    revalidatedBlocked.validated_output_path,
  ]);
  assert.equal(partialFinalized.watermark_advanced, false);
  assert.equal(partialFinalized.advanced_meeting_count, 0);
  assert.equal(fs.existsSync(partial.run_dir), false);
  const partialReport = JSON.parse(fs.readFileSync(partialFinalized.report_path, "utf8"));
  assert.equal(partialReport.meeting_results.length, 1);
  assert.equal(partialReport.meeting_results[0].disposition, "blocked-source");
  const stateAfterPartial = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(stateAfterPartial.source_revisions["feishu:pilot:partial-meeting"], undefined);
  assert.equal(stateAfterPartial.watermarks["feishu:pilot"].run_id, watermarkBeforePartialRunId);

  const fakeLarkPath = path.join(testRoot, "fake-lark.mjs");
  const fakeLarkLog = path.join(testRoot, "fake-lark.log");
  fs.writeFileSync(
    fakeLarkPath,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_LARK_LOG) fs.appendFileSync(process.env.FAKE_LARK_LOG, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  process.stdout.write("lark-cli version 1.0.39\\n");
} else if (args.includes("api") && args.includes("/open-apis/authen/v1/user_info")) {
  process.stdout.write(JSON.stringify({ok:true,data:{open_id:"provider-owner-placeholder"}}) + "\\n");
} else if (args.includes("calendar") && args.includes("+agenda")) {
  if (args.includes("--page-all") || args.includes("--page-limit")) process.exit(44);
  process.stdout.write(JSON.stringify({ok:true,data:[
    {event_id:"owned-event-private",event_organizer:{user_id:"provider-owner-placeholder"},start_time:{datetime:"2026-07-28T02:00:00.000Z"},end_time:{datetime:"2026-07-28T03:00:00.000Z"},summary:"Private owned title"},
    {event_id:"other-event-private",event_organizer:{user_id:"different-owner-placeholder"},start_time:{datetime:"2026-07-28T04:00:00.000Z"},end_time:{datetime:"2026-07-28T05:00:00.000Z"},summary:"Private other title"}
  ]}) + "\\n");
} else if (args.includes("vc") && args.includes("+notes")) {
  const index = args.indexOf("--calendar-event-ids");
  if (args[index + 1] !== "owned-event-private") process.exit(42);
  const notes = process.env.FAKE_BAD_LINEAGE
    ? [{meeting_id:"meeting-private",create_time:"1785204000",verbatim_doc_token:"token-private"}]
    : [{calendar_event_id:"owned-event-private",meeting_id:"meeting-private",create_time:"1785204000",verbatim_doc_token:"token-private"}];
  process.stdout.write(JSON.stringify({ok:true,data:{notes}}) + "\\n");
} else if (args.includes("docs") && args.includes("+fetch") && args.includes("v2")) {
  process.stdout.write(JSON.stringify({ok:true,data:{document:{
    document_id:"document-private",revision_id:7,content:"Synthetic transcript for deterministic adapter validation."
  }}}) + "\\n");
} else {
  process.exit(43);
}
`,
    { mode: 0o700 },
  );
  fs.chmodSync(fakeLarkPath, 0o700);
  const adapterConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  adapterConfig.feishu = {
    cli_path: fakeLarkPath,
    profile: "synthetic-profile",
  };
  writeJson(configPath, adapterConfig);
  process.env.FAKE_LARK_LOG = fakeLarkLog;
  const collected = run("collect-feishu.mjs", [
    "--config",
    configPath,
    "--start",
    "2026-07-28T00:00:00.000Z",
    "--end",
    "2026-07-29T00:00:00.000Z",
    "--run-key",
    "synthetic-adapter-run",
    "--tree-main-commit",
    "252b0fb25e52c127cd43ba4b8aa036c943ee5a56",
  ]);
  assert.equal(collected.adapter_version, "1.0.39");
  assert.equal(collected.owned_meeting_count, 1);
  assert.equal(collected.skipped_owner_count, 1);
  assert.equal(collected.fetched_transcript_count, 1);
  const adapterCapture = JSON.parse(fs.readFileSync(collected.capture_path, "utf8"));
  const adapterCaptureRoot = adapterCapture.ephemeral_root;
  assert.equal(adapterCapture.meetings[0].provider_meeting_id.includes("owned-event-private"), false);
  assert.equal(adapterCapture.meetings[0].segments.length, 1);
  assert.equal(fs.existsSync(adapterCapture.meetings[0].segments[0].text_file), true);
  const fakeCalls = fs
    .readFileSync(fakeLarkLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const notesCalls = fakeCalls.filter((call) => call.includes("+notes"));
  assert.equal(notesCalls.length, 1);
  assert.equal(notesCalls[0].includes("owned-event-private"), true);
  assert.equal(notesCalls[0].includes("other-event-private"), false);
  const identityCalls = fakeCalls.filter(
    (call) => call.includes("api") && call.includes("/open-apis/authen/v1/user_info"),
  );
  assert.equal(identityCalls.length, 1);

  if (process.platform !== "win32") {
    const isolatedSystemTemp = path.join(testRoot, "isolated-system-temp");
    const captureSymlinkTarget = path.join(testRoot, "capture-symlink-target");
    fs.mkdirSync(isolatedSystemTemp, { mode: 0o700 });
    fs.mkdirSync(captureSymlinkTarget, { mode: 0o700 });
    fs.symlinkSync(captureSymlinkTarget, path.join(isolatedSystemTemp, "return-meeting-context-capture"), "dir");
    const callsBeforeCaptureSymlink = fakeCalls.length;
    const captureSymlinkError = run(
      "collect-feishu.mjs",
      [
        "--config",
        configPath,
        "--start",
        "2026-07-28T00:00:00.000Z",
        "--end",
        "2026-07-29T00:00:00.000Z",
        "--run-key",
        "capture-symlink-run",
        "--tree-main-commit",
        "252b0fb25e52c127cd43ba4b8aa036c943ee5a56",
      ],
      {
        expectFailure: true,
        env: {
          TMPDIR: isolatedSystemTemp,
        },
      },
    );
    assert.match(captureSymlinkError, /return-meeting-context-capture must be a real directory/);
    assert.equal(fs.readFileSync(fakeLarkLog, "utf8").trim().split("\n").length, callsBeforeCaptureSymlink);
  }

  const mismatchedProfileConfig = structuredClone(adapterConfig);
  mismatchedProfileConfig.owner.provider_id = "different-owner-placeholder";
  const mismatchedProfileConfigPath = path.join(testRoot, "mismatched-profile-config.json");
  writeJson(mismatchedProfileConfigPath, mismatchedProfileConfig);
  const callsBeforeMismatch = fakeCalls.length;
  const profileMismatchError = run(
    "collect-feishu.mjs",
    [
      "--config",
      mismatchedProfileConfigPath,
      "--start",
      "2026-07-28T00:00:00.000Z",
      "--end",
      "2026-07-29T00:00:00.000Z",
      "--run-key",
      "profile-mismatch-run",
      "--tree-main-commit",
      "252b0fb25e52c127cd43ba4b8aa036c943ee5a56",
    ],
    { expectFailure: true },
  );
  assert.match(profileMismatchError, /does not match the authenticated lark profile/);
  const mismatchCalls = fs
    .readFileSync(fakeLarkLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .slice(callsBeforeMismatch);
  assert.equal(
    mismatchCalls.some((call) => call.includes("+agenda")),
    false,
  );

  process.env.FAKE_BAD_LINEAGE = "1";
  const callsBeforeBadLineage = fs.readFileSync(fakeLarkLog, "utf8").trim().split("\n").length;
  const badLineage = run("collect-feishu.mjs", [
    "--config",
    configPath,
    "--start",
    "2026-07-28T00:00:00.000Z",
    "--end",
    "2026-07-29T00:00:00.000Z",
    "--run-key",
    "bad-lineage-run",
    "--tree-main-commit",
    "252b0fb25e52c127cd43ba4b8aa036c943ee5a56",
  ]);
  delete process.env.FAKE_BAD_LINEAGE;
  assert.equal(badLineage.blocked_owned_count, 1);
  assert.equal(badLineage.fetched_transcript_count, 0);
  const badLineageCalls = fs
    .readFileSync(fakeLarkLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .slice(callsBeforeBadLineage);
  assert.equal(
    badLineageCalls.some((call) => call.includes("docs") && call.includes("+fetch")),
    false,
  );
  run("cleanup-capture.mjs", ["--capture", badLineage.capture_path]);

  adapterConfig.allowed_source_roots = [sourceRoot, adapterCaptureRoot];
  writeJson(configPath, adapterConfig);
  const customTempRoot = path.join(testRoot, "return-meeting-context-custom");
  const adapterPrepared = run("prepare-run.mjs", [
    "--config",
    configPath,
    "--capture",
    collected.capture_path,
    "--tmp-root",
    customTempRoot,
  ]);
  assert.equal(adapterPrepared.changed_meeting_count, 1);
  assert.equal(adapterPrepared.skipped_meeting_count, 1);
  assert.equal(path.dirname(adapterPrepared.run_dir), fs.realpathSync(customTempRoot));
  assert.equal(fs.existsSync(adapterCaptureRoot), false);
  assert.equal(fs.existsSync(adapterPrepared.analysis_input_path), true);
  const adapterInput = JSON.parse(fs.readFileSync(adapterPrepared.analysis_input_path, "utf8"));
  const overloadedOutput = analysisOutput(adapterInput);
  overloadedOutput.meeting_results[0].candidates = Array.from({ length: 4 }, (_, index) => {
    const candidate = validCandidate();
    candidate.claim.what = `Distinct durable confirmation candidate number ${index + 1}.`;
    return candidate;
  });
  const overloadedPath = path.join(adapterPrepared.run_dir, "overloaded-output.json");
  writeJson(overloadedPath, overloadedOutput);
  const overloadedError = run(
    "validate-output.mjs",
    ["--analysis-input", adapterPrepared.analysis_input_path, "--output", overloadedPath],
    { expectFailure: true },
  );
  assert.match(overloadedError, /exceeds max review candidates/);
  run("abort-run.mjs", ["--analysis-input", adapterPrepared.analysis_input_path]);
  assert.equal(fs.existsSync(adapterPrepared.run_dir), false);

  const explicitCaptureBase = path.join(os.tmpdir(), "return-meeting-context-capture");
  fs.mkdirSync(explicitCaptureBase, { recursive: true });
  const explicitCaptureRoot = fs.mkdtempSync(path.join(explicitCaptureBase, "capture-"));
  const explicitCapturePath = path.join(explicitCaptureRoot, "capture.json");
  writeJson(explicitCapturePath, {
    schema: "return-meeting-context.capture.v1",
    ephemeral_root: explicitCaptureRoot,
  });
  const cleaned = run("cleanup-capture.mjs", ["--capture", explicitCapturePath]);
  assert.equal(cleaned.capture_root_removed, true);

  process.stdout.write("return-meeting-context deterministic tests passed\n");
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
