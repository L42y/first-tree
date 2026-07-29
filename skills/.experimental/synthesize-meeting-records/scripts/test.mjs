#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateArtifactBundle, validateMeetingAnalysisPacket } from "./lib.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

function bundle(overrides = {}) {
  return {
    schema: "synthesize-meeting-records.artifact-bundle.v1",
    meeting_scope: "single-meeting",
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

function item(overrides = {}) {
  return {
    category: "decision",
    statement: "Use a provider-neutral artifact contract for meeting analysis.",
    context: "The contract keeps reading separate from analysis and downstream publication.",
    settlement: {
      status: "confirmed",
      basis: "human_confirmed_minutes",
    },
    chronology: {
      later_override_checked: true,
      overridden_items_excluded: true,
    },
    evidence: [{ artifact_id: "minutes", location_hint: "Decision section" }],
    ...overrides,
  };
}

function packet(bundleValue, overrides = {}) {
  const prepared = validateArtifactBundle(bundleValue);
  return {
    schema: "synthesize-meeting-records.meeting-analysis-packet.v1",
    source_revision: prepared.source_revision,
    status: "complete",
    reason: "The supplied minutes establish one confirmed decision.",
    items: [item()],
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

const alternateLocatorBundle = bundle({
  artifacts: [
    {
      ...bundle().artifacts[0],
      content_ref: { ...bundle().artifacts[0].content_ref, locator: "source-artifacts/other-minutes.md" },
    },
  ],
});
assert.notEqual(
  validateArtifactBundle(bundle()).source_revision,
  validateArtifactBundle(alternateLocatorBundle).source_revision,
  "source_revision must change when only the supplied artifact locator changes",
);

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
expectReject(
  () =>
    validateArtifactBundle(
      bundle({
        artifacts: [
          { ...bundle().artifacts[0], artifact_id: "later", chronology_index: 1 },
          { ...bundle().artifacts[0], artifact_id: "earlier", chronology_index: 0 },
        ],
      }),
    ),
  /ordered by chronology_index/u,
);

for (const completeness of ["partial", "unknown"]) {
  const incompleteBundle = bundle({
    artifacts: [
      {
        ...bundle().artifacts[0],
        completeness,
        extraction_warnings: ["A page could not be read."],
      },
    ],
  });
  assert.equal(validateArtifactBundle(incompleteBundle).source_status, "blocked-source");
  assert.doesNotThrow(() =>
    validateMeetingAnalysisPacket(
      incompleteBundle,
      packet(incompleteBundle, {
        status: "blocked-source",
        reason: "The supplied attachment is incomplete.",
        items: [],
      }),
    ),
  );
  expectReject(
    () =>
      validateMeetingAnalysisPacket(
        incompleteBundle,
        packet(incompleteBundle, {
          status: "no-findings",
          reason: "No meaningful meeting content.",
          items: [],
        }),
      ),
    /requires every artifact to be complete/u,
  );
}

const unknownRoleBundle = bundle({
  artifacts: [{ ...bundle().artifacts[0], source_role: "unknown" }],
});
assert.equal(validateArtifactBundle(unknownRoleBundle).source_status, "blocked-source");
assert.doesNotThrow(() =>
  validateMeetingAnalysisPacket(
    unknownRoleBundle,
    packet(unknownRoleBundle, {
      status: "blocked-source",
      reason: "The source provenance cannot be classified safely.",
      items: [],
    }),
  ),
);
expectReject(
  () =>
    validateMeetingAnalysisPacket(
      unknownRoleBundle,
      packet(unknownRoleBundle, {
        status: "needs-confirmation",
        reason: "The source role is unknown.",
        items: [item({ settlement: { status: "uncertain", basis: "unknown" } })],
      }),
    ),
  /requires every artifact to be complete/u,
);

const completeBundle = bundle();
assert.doesNotThrow(() =>
  validateMeetingAnalysisPacket(
    completeBundle,
    packet(completeBundle, {
      status: "no-findings",
      reason: "The complete source contains only logistics.",
      items: [],
    }),
  ),
);

const categories = ["decision", "progress", "plan", "action", "blocker", "risk"];
assert.doesNotThrow(() =>
  validateMeetingAnalysisPacket(
    completeBundle,
    packet(completeBundle, {
      reason: "The minutes establish one item in each supported category.",
      items: categories.map((category) =>
        item({
          category,
          statement: `Synthetic ${category} statement.`,
          context: `Synthetic ${category} context.`,
          ...(category === "action" ? { attribution: "Delivery lead" } : {}),
        }),
      ),
    }),
  ),
);

const aiBundle = bundle({
  artifacts: [{ ...bundle().artifacts[0], source_role: "ai_notes" }],
});
expectReject(
  () =>
    validateMeetingAnalysisPacket(
      aiBundle,
      packet(aiBundle, {
        items: [item({ settlement: { status: "confirmed", basis: "ai_generated_summary" } })],
      }),
    ),
  /weak settlement basis/u,
);
for (const forgedBasis of [
  "human_confirmed_minutes",
  "explicit_decision_record",
  "transcript_explicit_human_statement",
]) {
  expectReject(
    () =>
      validateMeetingAnalysisPacket(
        aiBundle,
        packet(aiBundle, {
          items: [item({ settlement: { status: "confirmed", basis: forgedBasis } })],
        }),
      ),
    /requires cited evidence with source_role/u,
  );
}
assert.doesNotThrow(() =>
  validateMeetingAnalysisPacket(
    aiBundle,
    packet(aiBundle, {
      status: "needs-confirmation",
      reason: "AI notes identify an item but do not prove confirmation.",
      items: [item({ settlement: { status: "uncertain", basis: "ai_generated_summary" } })],
    }),
  ),
);

for (const [basis, sourceRole] of [
  ["human_confirmed_minutes", "human_minutes"],
  ["explicit_decision_record", "decision_record"],
  ["transcript_explicit_human_statement", "transcript"],
]) {
  const matchingBundle = bundle({
    artifacts: [{ ...bundle().artifacts[0], source_role: sourceRole }],
  });
  assert.doesNotThrow(() =>
    validateMeetingAnalysisPacket(
      matchingBundle,
      packet(matchingBundle, {
        items: [item({ settlement: { status: "confirmed", basis } })],
      }),
    ),
  );
}

expectReject(
  () =>
    validateMeetingAnalysisPacket(
      completeBundle,
      packet(completeBundle, {
        items: [
          item({
            chronology: { later_override_checked: false, overridden_items_excluded: true },
          }),
        ],
      }),
    ),
  /incomplete later-override gates/u,
);

expectReject(
  () =>
    validateMeetingAnalysisPacket(
      completeBundle,
      packet(completeBundle, {
        items: [item({ evidence: [{ artifact_id: "unknown", location_hint: "Decision section" }] })],
      }),
    ),
  /unknown artifact_id/u,
);

expectReject(
  () =>
    validateMeetingAnalysisPacket(
      completeBundle,
      packet(completeBundle, {
        items: [item({ settlement: { status: "uncertain", basis: "unknown" } })],
      }),
    ),
  /must be confirmed for complete/u,
);
expectReject(
  () =>
    validateMeetingAnalysisPacket(
      completeBundle,
      packet(completeBundle, {
        status: "needs-confirmation",
        reason: "No uncertain item exists.",
      }),
    ),
  /requires at least one uncertain item/u,
);
expectReject(
  () =>
    validateMeetingAnalysisPacket(
      completeBundle,
      packet(completeBundle, {
        status: "no-findings",
        reason: "Contradictory output.",
      }),
    ),
  /requires zero items/u,
);
expectReject(
  () =>
    validateMeetingAnalysisPacket(
      completeBundle,
      packet(completeBundle, {
        status: "blocked-source",
        reason: "Contradictory output.",
        items: [],
      }),
    ),
  /requires an incomplete or unclassifiable artifact/u,
);

expectReject(
  () => validateMeetingAnalysisPacket(completeBundle, { ...packet(completeBundle), raw_excerpt: "copied text" }),
  /unknown field/u,
);

for (const [unsafePacket, pattern] of [
  [packet(completeBundle, { reason: "See https://example.invalid/private" }), /forbidden URI/u],
  [packet(completeBundle, { reason: "See file:///tmp/source.md" }), /forbidden URI/u],
  [packet(completeBundle, { reason: "/etc/passwd" }), /forbidden absolute path/u],
  [
    packet(completeBundle, {
      items: [item({ statement: "Read ../source/minutes.md before continuing." })],
    }),
    /forbidden relative path/u,
  ],
  [packet(completeBundle, { reason: "Stored at private/source-token" }), /forbidden relative path/u],
  [
    packet(completeBundle, {
      items: [item({ context: "The confidential material is under records/confidential." })],
    }),
    /forbidden relative path/u,
  ],
  [
    packet(completeBundle, {
      items: [item({ context: "The evidence is recorded in minutes.md." })],
    }),
    /forbidden filename/u,
  ],
  [
    packet(completeBundle, {
      items: [item({ attribution: "ou_1234567890" })],
    }),
    /forbidden provider identifier/u,
  ],
  [
    packet(completeBundle, {
      items: [
        item({
          evidence: [{ artifact_id: "minutes", location_hint: "doxcnABCdef1234567890" }],
        }),
      ],
    }),
    /forbidden provider document token/u,
  ],
  [packet(completeBundle, { reason: "Contact person@example.invalid" }), /forbidden email address/u],
  [
    packet(completeBundle, { reason: "Call +1 (415) 555-2671 for follow-up." }),
    /packet\.reason contains a forbidden phone number/u,
  ],
  [
    packet(completeBundle, {
      items: [item({ statement: "Owner phone 415-555-2671 coordinates the follow-up." })],
    }),
    /packet\.items\[0\]\.statement contains a forbidden phone number/u,
  ],
  [
    packet(completeBundle, {
      items: [item({ context: "Confirm the result by calling (415) 555-2671." })],
    }),
    /packet\.items\[0\]\.context contains a forbidden phone number/u,
  ],
  [
    packet(completeBundle, {
      items: [item({ attribution: "Call +1 415 555 2671" })],
    }),
    /packet\.items\[0\]\.attribution contains a forbidden phone number/u,
  ],
  [
    packet(completeBundle, {
      items: [
        item({
          evidence: [{ artifact_id: "minutes", location_hint: "Call 415.555.2671" }],
        }),
      ],
    }),
    /packet\.items\[0\]\.evidence\[0\]\.location_hint contains a forbidden phone number/u,
  ],
  [
    packet(completeBundle, {
      items: [item({ statement: "Credential sk-proj-1234567890abcdef was supplied." })],
    }),
    /forbidden secret/u,
  ],
  [
    packet(completeBundle, {
      items: [item({ context: "Credential xoxb-1234567890abcdef was supplied." })],
    }),
    /forbidden secret/u,
  ],
  [
    packet(completeBundle, {
      items: [item({ attribution: "Bearer abcdefghijklmnop" })],
    }),
    /forbidden credential/u,
  ],
  [packet(completeBundle, { reason: "Budget is $1000" }), /forbidden exact currency amount/u],
]) {
  expectReject(() => validateMeetingAnalysisPacket(completeBundle, unsafePacket), pattern);
}

const unsafeAttribution = packet(completeBundle, {
  items: [item({ attribution: "person@example.invalid" })],
});
expectReject(() => validateMeetingAnalysisPacket(completeBundle, unsafeAttribution), /forbidden email address/u);

assert.doesNotThrow(() =>
  validateMeetingAnalysisPacket(
    completeBundle,
    packet(completeBundle, {
      reason: "An A/B experiment and/or staged review remains valid on 2026/07/29.",
    }),
  ),
);

const identifierBundle = bundle({
  artifacts: [{ ...bundle().artifacts[0], artifact_id: "artifact-415-555-2671" }],
});
assert.doesNotThrow(() =>
  validateMeetingAnalysisPacket(
    identifierBundle,
    packet(identifierBundle, {
      reason: "An A/B experiment and/or staged review remains valid on 2026/07/29.",
      items: [
        item({
          statement: "Version v4.15.5 processed 2671 records in 2026.",
          context: "Ordinary counts are 415, 555, and 2671.",
          evidence: [{ artifact_id: "artifact-415-555-2671", location_hint: "Section 4.15.5" }],
        }),
      ],
    }),
  ),
);

const stale = packet(completeBundle, { source_revision: "0".repeat(64) });
expectReject(() => validateMeetingAnalysisPacket(completeBundle, stale), /does not match/u);

const tempRoot = mkdtempSync(join(tmpdir(), "synthesize-meeting-records-contract-test-"));
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
  assert.match(prepared.stdout, /synthesize-meeting-records\.prepared-artifacts\.v1/u);
  const validated = spawnSync(
    process.execPath,
    [join(scriptsDir, "validate-output.mjs"), "--bundle", bundlePath, "--output", packetPath],
    { encoding: "utf8" },
  );
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, /synthesize-meeting-records\.meeting-analysis-packet\.v1/u);
  assert.deepEqual(readdirSync(tempRoot).sort(), before);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

process.stdout.write("synthesize-meeting-records deterministic tests passed\n");
