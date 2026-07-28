#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateArtifactBundle, validateDecisionPacket } from "./lib.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

function bundle(overrides = {}) {
  return {
    schema: "return-meeting-context.artifact-bundle.v1",
    meeting_scope: "single-meeting",
    requested_intent: "write",
    artifacts: [
      {
        artifact_id: "minutes",
        input_kind: "attachment",
        media_type: "text/markdown",
        source_role: "human_minutes",
        revision: "sha256:synthetic-revision",
        completeness: "complete",
        chronology_index: 0,
        content_ref: { kind: "task_file", locator: "source-artifacts/minutes.md" },
        extraction_warnings: [],
      },
    ],
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    claim: {
      what: "Meeting context starts from artifacts the user explicitly supplies.",
      why: "The explicit boundary works across providers without hidden discovery.",
      constraints: ["Raw meeting content remains outside persistent output."],
    },
    settlement: {
      status: "settled",
      basis: "human_confirmed_minutes",
    },
    chronology: {
      later_override_checked: true,
      overridden_claims_excluded: true,
    },
    evidence: [{ artifact_id: "minutes", location_hint: "Decision section" }],
    ...overrides,
  };
}

function packet(bundleValue, overrides = {}) {
  const prepared = validateArtifactBundle(bundleValue);
  return {
    schema: "return-meeting-context.decision-evidence-packet.v1",
    source_revision: prepared.source_revision,
    status: "ready-for-write",
    reason: "One settled durable decision survives the supplied chronology.",
    handoff: "first-tree-write",
    candidates: [candidate()],
    ...overrides,
  };
}

function expectReject(action, pattern) {
  assert.throws(action, pattern);
}

for (const inputKind of ["provider_link", "attachment", "local_file", "pasted_text"]) {
  const value = bundle({
    artifacts: [{ ...bundle().artifacts[0], input_kind: inputKind }],
  });
  assert.equal(validateArtifactBundle(value).source_status, "complete");
}

const ordered = bundle({
  artifacts: [
    { ...bundle().artifacts[0], artifact_id: "proposal", chronology_index: 0 },
    {
      ...bundle().artifacts[0],
      artifact_id: "final",
      input_kind: "provider_link",
      source_role: "decision_record",
      revision: "provider-revision-2",
      chronology_index: 1,
      content_ref: { kind: "conversation", locator: "current-user-supplied-document" },
    },
  ],
});
assert.equal(validateArtifactBundle(ordered).bundle.artifacts[1].artifact_id, "final");

expectReject(
  () =>
    validateArtifactBundle(
      bundle({
        artifacts: [bundle().artifacts[0], { ...bundle().artifacts[0], chronology_index: 1 }],
      }),
    ),
  /Duplicate artifact_id/u,
);
expectReject(
  () =>
    validateArtifactBundle(
      bundle({
        artifacts: [bundle().artifacts[0], { ...bundle().artifacts[0], artifact_id: "second" }],
      }),
    ),
  /Duplicate chronology_index/u,
);

const partialBundle = bundle({
  artifacts: [{ ...bundle().artifacts[0], completeness: "partial", extraction_warnings: ["OCR page missing"] }],
});
assert.equal(validateArtifactBundle(partialBundle).source_status, "blocked-source");
assert.doesNotThrow(() =>
  validateDecisionPacket(
    partialBundle,
    packet(partialBundle, {
      status: "blocked-source",
      reason: "The supplied attachment is incomplete.",
      handoff: "none",
      candidates: [],
    }),
  ),
);
expectReject(
  () =>
    validateDecisionPacket(
      partialBundle,
      packet(partialBundle, { status: "no-change", reason: "Nothing durable.", handoff: "none", candidates: [] }),
    ),
  /requires every artifact to be complete/u,
);

const completeBundle = bundle();
assert.doesNotThrow(() =>
  validateDecisionPacket(
    completeBundle,
    packet(completeBundle, { status: "no-change", reason: "Only progress updates.", handoff: "none", candidates: [] }),
  ),
);

const aiBundle = bundle({
  artifacts: [{ ...bundle().artifacts[0], source_role: "ai_notes" }],
});
expectReject(
  () =>
    validateDecisionPacket(
      aiBundle,
      packet(aiBundle, {
        candidates: [candidate({ settlement: { status: "settled", basis: "ai_generated_summary" } })],
      }),
    ),
  /weak settlement basis/u,
);
assert.doesNotThrow(() =>
  validateDecisionPacket(
    aiBundle,
    packet(aiBundle, {
      status: "needs-confirmation",
      reason: "AI notes identify a candidate but do not prove settlement.",
      handoff: "none",
      candidates: [candidate({ settlement: { status: "uncertain", basis: "ai_generated_summary" } })],
    }),
  ),
);

expectReject(
  () =>
    validateDecisionPacket(
      completeBundle,
      packet(completeBundle, {
        candidates: [
          candidate({
            chronology: { later_override_checked: false, overridden_claims_excluded: true },
          }),
        ],
      }),
    ),
  /incomplete later-override gates/u,
);

expectReject(
  () =>
    validateDecisionPacket(
      completeBundle,
      packet(completeBundle, {
        candidates: [candidate({ evidence: [{ artifact_id: "unknown", location_hint: "Decision section" }] })],
      }),
    ),
  /unknown artifact_id/u,
);

const analyzeBundle = bundle({ requested_intent: "analyze" });
expectReject(() => validateDecisionPacket(analyzeBundle, packet(analyzeBundle)), /requires handoff 'none'/u);
assert.doesNotThrow(() => validateDecisionPacket(analyzeBundle, packet(analyzeBundle, { handoff: "none" })));

for (const unsafe of [
  { raw_excerpt: "copied meeting text" },
  { note: "https://example.invalid/private" },
  { note: "ou_1234567890" },
  { note: "person@example.invalid" },
  { note: "/Users/example/private.txt" },
  { note: "Budget is $1000" },
]) {
  expectReject(
    () => validateDecisionPacket(completeBundle, { ...packet(completeBundle), ...unsafe }),
    /unknown field|forbidden/u,
  );
}

const stale = packet(completeBundle, { source_revision: "0".repeat(64) });
expectReject(() => validateDecisionPacket(completeBundle, stale), /does not match/u);

const tempRoot = mkdtempSync(join(tmpdir(), "return-meeting-context-contract-test-"));
try {
  const bundlePath = join(tempRoot, "bundle.json");
  const packetPath = join(tempRoot, "packet.json");
  writeFileSync(bundlePath, `${JSON.stringify(completeBundle, null, 2)}\n`, "utf8");
  writeFileSync(packetPath, `${JSON.stringify(packet(completeBundle), null, 2)}\n`, "utf8");
  const before = readdirSync(tempRoot).sort();
  const prepared = spawnSync(process.execPath, [join(scriptsDir, "prepare-artifacts.mjs"), "--bundle", bundlePath], {
    encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /return-meeting-context\.prepared-artifacts\.v1/u);
  const validated = spawnSync(
    process.execPath,
    [join(scriptsDir, "validate-output.mjs"), "--bundle", bundlePath, "--output", packetPath],
    { encoding: "utf8" },
  );
  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(readdirSync(tempRoot).sort(), before);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

process.stdout.write("return-meeting-context deterministic tests passed\n");
