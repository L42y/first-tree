import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const INPUT_KINDS = ["provider_link", "attachment", "local_file", "pasted_text"];
const SOURCE_ROLES = ["human_minutes", "ai_notes", "transcript", "decision_record", "unknown"];
const COMPLETENESS = ["complete", "partial", "unknown"];
const INTENTS = ["analyze", "write"];
const CONTENT_REF_KINDS = ["conversation", "task_file"];
const PACKET_STATUSES = ["no-change", "needs-confirmation", "ready-for-write", "blocked-source"];
const HANDOFFS = ["none", "first-tree-write"];
const SETTLEMENT_STATUSES = ["settled", "uncertain"];
const SETTLEMENT_BASES = [
  "human_confirmed_minutes",
  "explicit_decision_record",
  "transcript_explicit_human_choice",
  "ai_generated_summary",
  "unknown",
];
const STRONG_SETTLEMENT_BASES = new Set([
  "human_confirmed_minutes",
  "explicit_decision_record",
  "transcript_explicit_human_choice",
]);
const SETTLEMENT_BASIS_SOURCE_ROLES = new Map([
  ["human_confirmed_minutes", "human_minutes"],
  ["explicit_decision_record", "decision_record"],
  ["transcript_explicit_human_choice", "transcript"],
]);

const FORBIDDEN_KEY_PARTS = [
  "raw",
  "content",
  "excerpt",
  "transcript_text",
  "url",
  "locator",
  "file_path",
  "source_path",
  "token",
  "open_id",
  "provider_id",
  "participant",
  "speaker",
  "credential",
  "secret",
];

function fail(message) {
  throw new Error(message);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function parseArgs(argv, required) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (typeof key !== "string" || !key.startsWith("--") || value === undefined) {
      fail("Arguments must use --name <value> pairs.");
    }
    parsed[key.slice(2)] = value;
  }
  for (const name of required) {
    if (typeof parsed[name] !== "string" || parsed[name].length === 0) {
      fail(`Missing required --${name}.`);
    }
  }
  return parsed;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object.`);
  return value;
}

function requireAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unknown field '${key}'.`);
  }
}

function requireKeys(value, required, label) {
  for (const key of required) {
    if (!(key in value)) fail(`${label} is missing '${key}'.`);
  }
}

function requireString(value, label, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(`${label} must be a string between ${min} and ${max} characters.`);
  }
  return value;
}

function requireEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
}

function requireStringArray(value, label, maxItems, maxChars) {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(`${label} must be an array with at most ${maxItems} items.`);
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`, 1, maxChars));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceRevision(bundle) {
  const projection = {
    meeting_scope: bundle.meeting_scope,
    requested_intent: bundle.requested_intent,
    artifacts: bundle.artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      chronology_index: artifact.chronology_index,
      completeness: artifact.completeness,
      extraction_warnings: artifact.extraction_warnings,
      input_kind: artifact.input_kind,
      media_type: artifact.media_type,
      revision: artifact.revision,
      content_ref_digest: sha256(stableStringify(artifact.content_ref)),
      source_role: artifact.source_role,
    })),
  };
  return sha256(stableStringify(projection));
}

export function validateArtifactBundle(input) {
  const bundle = requireObject(input, "bundle");
  const topKeys = ["schema", "meeting_scope", "requested_intent", "artifacts"];
  requireAllowedKeys(bundle, topKeys, "bundle");
  requireKeys(bundle, topKeys, "bundle");
  if (bundle.schema !== "return-meeting-context.artifact-bundle.v1") {
    fail("bundle.schema is unsupported.");
  }
  if (bundle.meeting_scope !== "single-meeting") {
    fail("bundle.meeting_scope must be single-meeting.");
  }
  requireEnum(bundle.requested_intent, INTENTS, "bundle.requested_intent");
  if (!Array.isArray(bundle.artifacts) || bundle.artifacts.length < 1 || bundle.artifacts.length > 8) {
    fail("bundle.artifacts must contain between 1 and 8 artifacts.");
  }

  const ids = new Set();
  const chronology = new Set();
  const artifacts = bundle.artifacts.map((value, index) => {
    const label = `bundle.artifacts[${index}]`;
    const artifact = requireObject(value, label);
    const keys = [
      "artifact_id",
      "input_kind",
      "media_type",
      "source_role",
      "revision",
      "completeness",
      "chronology_index",
      "content_ref",
      "extraction_warnings",
    ];
    requireAllowedKeys(artifact, keys, label);
    requireKeys(artifact, keys, label);
    const artifactId = requireString(artifact.artifact_id, `${label}.artifact_id`, 1, 64);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(artifactId)) {
      fail(`${label}.artifact_id has an invalid format.`);
    }
    if (ids.has(artifactId)) fail(`Duplicate artifact_id '${artifactId}'.`);
    ids.add(artifactId);
    requireEnum(artifact.input_kind, INPUT_KINDS, `${label}.input_kind`);
    requireString(artifact.media_type, `${label}.media_type`, 3, 120);
    requireEnum(artifact.source_role, SOURCE_ROLES, `${label}.source_role`);
    requireString(artifact.revision, `${label}.revision`, 1, 200);
    requireEnum(artifact.completeness, COMPLETENESS, `${label}.completeness`);
    if (!Number.isInteger(artifact.chronology_index) || artifact.chronology_index < 0) {
      fail(`${label}.chronology_index must be a non-negative integer.`);
    }
    if (chronology.has(artifact.chronology_index)) {
      fail(`Duplicate chronology_index '${artifact.chronology_index}'.`);
    }
    chronology.add(artifact.chronology_index);
    const contentRef = requireObject(artifact.content_ref, `${label}.content_ref`);
    requireAllowedKeys(contentRef, ["kind", "locator"], `${label}.content_ref`);
    requireKeys(contentRef, ["kind", "locator"], `${label}.content_ref`);
    requireEnum(contentRef.kind, CONTENT_REF_KINDS, `${label}.content_ref.kind`);
    requireString(contentRef.locator, `${label}.content_ref.locator`, 1, 1024);
    requireStringArray(artifact.extraction_warnings, `${label}.extraction_warnings`, 8, 240);
    return artifact;
  });

  for (let index = 1; index < artifacts.length; index += 1) {
    if (artifacts[index - 1].chronology_index > artifacts[index].chronology_index) {
      fail("bundle.artifacts must be ordered by chronology_index.");
    }
  }

  return {
    bundle,
    source_revision: sourceRevision(bundle),
    source_status: artifacts.every((artifact) => artifact.completeness === "complete") ? "complete" : "blocked-source",
  };
}

function scanPrivateOutput(value, path = "packet") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scanPrivateOutput(item, `${path}[${index}]`);
    });
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (FORBIDDEN_KEY_PARTS.some((part) => normalizedKey.includes(part))) {
        fail(`${path} contains forbidden raw/private field '${key}'.`);
      }
      scanPrivateOutput(child, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  const checks = [
    [/https?:\/\//iu, "URL"],
    [/(?:^|\s)\/(?:Users|home|tmp|var|private|mnt)\//u, "absolute path"],
    [/[A-Za-z]:\\(?:Users|Temp|Documents)\\/u, "absolute path"],
    [/\b(?:ou|on|oc|cli|docx|doxcn)_[A-Za-z0-9_-]{8,}\b/u, "provider identifier"],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu, "email address"],
    [/\b(?:sk|ghp|gho|xox[baprs])_[A-Za-z0-9_-]{8,}\b/u, "secret"],
    [/(?:[$€£¥￥]\s?\d[\d,.]*|\b(?:USD|EUR|GBP|CNY|RMB)\s+\d[\d,.]*)/iu, "exact currency amount"],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(value)) fail(`${path} contains a forbidden ${label}.`);
  }
}

function validateCandidate(value, index, artifactRoles) {
  const label = `packet.candidates[${index}]`;
  const candidate = requireObject(value, label);
  const keys = ["claim", "settlement", "chronology", "evidence"];
  requireAllowedKeys(candidate, keys, label);
  requireKeys(candidate, keys, label);

  const claim = requireObject(candidate.claim, `${label}.claim`);
  requireAllowedKeys(claim, ["what", "why", "constraints"], `${label}.claim`);
  requireKeys(claim, ["what", "why", "constraints"], `${label}.claim`);
  requireString(claim.what, `${label}.claim.what`, 1, 500);
  requireString(claim.why, `${label}.claim.why`, 1, 1000);
  requireStringArray(claim.constraints, `${label}.claim.constraints`, 8, 400);

  const settlement = requireObject(candidate.settlement, `${label}.settlement`);
  requireAllowedKeys(settlement, ["status", "basis"], `${label}.settlement`);
  requireKeys(settlement, ["status", "basis"], `${label}.settlement`);
  requireEnum(settlement.status, SETTLEMENT_STATUSES, `${label}.settlement.status`);
  requireEnum(settlement.basis, SETTLEMENT_BASES, `${label}.settlement.basis`);
  if (settlement.status === "settled" && !STRONG_SETTLEMENT_BASES.has(settlement.basis)) {
    fail(`${label} uses a weak settlement basis for a settled claim.`);
  }

  const chronology = requireObject(candidate.chronology, `${label}.chronology`);
  requireAllowedKeys(chronology, ["later_override_checked", "overridden_claims_excluded"], `${label}.chronology`);
  requireKeys(chronology, ["later_override_checked", "overridden_claims_excluded"], `${label}.chronology`);
  requireBoolean(chronology.later_override_checked, `${label}.chronology.later_override_checked`);
  requireBoolean(chronology.overridden_claims_excluded, `${label}.chronology.overridden_claims_excluded`);

  if (!Array.isArray(candidate.evidence) || candidate.evidence.length < 1 || candidate.evidence.length > 3) {
    fail(`${label}.evidence must contain between 1 and 3 items.`);
  }
  const citedSourceRoles = new Set();
  for (let evidenceIndex = 0; evidenceIndex < candidate.evidence.length; evidenceIndex += 1) {
    const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
    const evidence = requireObject(candidate.evidence[evidenceIndex], evidenceLabel);
    requireAllowedKeys(evidence, ["artifact_id", "location_hint"], evidenceLabel);
    requireKeys(evidence, ["artifact_id", "location_hint"], evidenceLabel);
    const artifactId = requireString(evidence.artifact_id, `${evidenceLabel}.artifact_id`, 1, 64);
    const sourceRole = artifactRoles.get(artifactId);
    if (sourceRole === undefined) fail(`${evidenceLabel} references an unknown artifact_id.`);
    citedSourceRoles.add(sourceRole);
    requireString(evidence.location_hint, `${evidenceLabel}.location_hint`, 1, 200);
  }
  const requiredSourceRole = SETTLEMENT_BASIS_SOURCE_ROLES.get(settlement.basis);
  if (requiredSourceRole !== undefined && !citedSourceRoles.has(requiredSourceRole)) {
    fail(
      `${label}.settlement.basis '${settlement.basis}' requires cited evidence with source_role '${requiredSourceRole}'.`,
    );
  }
  return candidate;
}

export function validateDecisionPacket(bundleInput, packetInput) {
  const prepared = validateArtifactBundle(bundleInput);
  const packet = requireObject(packetInput, "packet");
  const keys = ["schema", "source_revision", "status", "reason", "handoff", "candidates"];
  requireAllowedKeys(packet, keys, "packet");
  requireKeys(packet, keys, "packet");
  if (packet.schema !== "return-meeting-context.decision-evidence-packet.v1") {
    fail("packet.schema is unsupported.");
  }
  if (packet.source_revision !== prepared.source_revision) {
    fail("packet.source_revision does not match the supplied artifact bundle.");
  }
  requireEnum(packet.status, PACKET_STATUSES, "packet.status");
  requireString(packet.reason, "packet.reason", 1, 400);
  requireEnum(packet.handoff, HANDOFFS, "packet.handoff");
  if (!Array.isArray(packet.candidates) || packet.candidates.length > 3) {
    fail("packet.candidates must be an array with at most 3 items.");
  }
  const artifactRoles = new Map(
    prepared.bundle.artifacts.map((artifact) => [artifact.artifact_id, artifact.source_role]),
  );
  const candidates = packet.candidates.map((candidate, index) => validateCandidate(candidate, index, artifactRoles));

  if (packet.status === "blocked-source") {
    if (prepared.source_status !== "blocked-source") fail("blocked-source requires an incomplete artifact.");
    if (candidates.length !== 0 || packet.handoff !== "none") {
      fail("blocked-source requires zero candidates and no handoff.");
    }
  } else {
    if (prepared.source_status !== "complete") fail(`${packet.status} requires every artifact to be complete.`);
  }

  if (packet.status === "no-change" && (candidates.length !== 0 || packet.handoff !== "none")) {
    fail("no-change requires zero candidates and no handoff.");
  }

  if (packet.status === "needs-confirmation") {
    if (candidates.length === 0 || !candidates.some((candidate) => candidate.settlement.status === "uncertain")) {
      fail("needs-confirmation requires at least one uncertain candidate.");
    }
    if (packet.handoff !== "none") fail("needs-confirmation cannot hand off to first-tree-write.");
  }

  if (packet.status === "ready-for-write") {
    if (candidates.length === 0) fail("ready-for-write requires at least one candidate.");
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.settlement.status !== "settled") {
        fail(`packet.candidates[${index}] must be settled for ready-for-write.`);
      }
      if (!candidate.chronology.later_override_checked || !candidate.chronology.overridden_claims_excluded) {
        fail(`packet.candidates[${index}] has incomplete later-override gates.`);
      }
    }
    const expectedHandoff = prepared.bundle.requested_intent === "write" ? "first-tree-write" : "none";
    if (packet.handoff !== expectedHandoff) {
      fail(`ready-for-write requires handoff '${expectedHandoff}' for the requested intent.`);
    }
  }

  if ((packet.status === "no-change" || packet.status === "blocked-source") && packet.handoff !== "none") {
    fail(`${packet.status} cannot hand off to first-tree-write.`);
  }

  scanPrivateOutput(packet);
  return { packet, source_revision: prepared.source_revision };
}
