import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const INPUT_KINDS = ["provider_link", "attachment", "local_file", "pasted_text"];
const SOURCE_ROLES = ["human_minutes", "ai_notes", "transcript", "decision_record", "unknown"];
const COMPLETENESS = ["complete", "partial", "unknown"];
const CONTENT_REF_KINDS = ["conversation", "task_file"];
const PACKET_STATUSES = ["complete", "needs-confirmation", "no-findings", "blocked-source"];
const ITEM_CATEGORIES = ["decision", "progress", "plan", "action", "blocker", "risk"];
const SETTLEMENT_STATUSES = ["confirmed", "uncertain"];
const SETTLEMENT_BASES = [
  "human_confirmed_minutes",
  "explicit_decision_record",
  "transcript_explicit_human_statement",
  "ai_generated_summary",
  "unknown",
];
const STRONG_SETTLEMENT_BASES = new Set([
  "human_confirmed_minutes",
  "explicit_decision_record",
  "transcript_explicit_human_statement",
]);
const SETTLEMENT_BASIS_SOURCE_ROLES = new Map([
  ["human_confirmed_minutes", "human_minutes"],
  ["explicit_decision_record", "decision_record"],
  ["transcript_explicit_human_statement", "transcript"],
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
  const topKeys = ["schema", "meeting_scope", "artifacts"];
  requireAllowedKeys(bundle, topKeys, "bundle");
  requireKeys(bundle, topKeys, "bundle");
  if (bundle.schema !== "synthesize-meeting-records.artifact-bundle.v1") {
    fail("bundle.schema is unsupported.");
  }
  if (bundle.meeting_scope !== "single-meeting") {
    fail("bundle.meeting_scope must be single-meeting.");
  }
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
    source_status: artifacts.every(
      (artifact) => artifact.completeness === "complete" && artifact.source_role !== "unknown",
    )
      ? "complete"
      : "blocked-source",
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
  if (path === "packet.source_revision") return;
  const checks = [
    [/[\r\n\t]/u, "multi-line or control character"],
    [/[\\/]/u, "path or URL delimiter"],
    [/\b(?:https?|file|ftp|s3|gs|mailto):/iu, "URI"],
    [/\b[\w.-]+\.(?:csv|docx?|html?|json|md|pdf|pptx?|text|tsv|txt|xlsx?|ya?ml)\b/iu, "filename"],
    [/\b(?:ou|on|oc|cli)_[A-Za-z0-9_-]{8,}\b/u, "provider identifier"],
    [/\b(?:boxcn|docx?|doxcn|fldcn|shtcn|wiki)[A-Za-z0-9_-]{8,}\b/iu, "provider document token"],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu, "email address"],
    [/\b(?:sk(?:-proj)?|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/iu, "secret"],
    [/\b(?:basic|bearer)\s+[A-Za-z0-9._~+=-]{8,}\b/iu, "credential"],
    [/(?:[$€£¥￥]\s?\d[\d,.]*|\b(?:USD|EUR|GBP|CNY|RMB)\s+\d[\d,.]*)/iu, "exact currency amount"],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(value)) fail(`${path} contains a forbidden ${label}.`);
  }
}

function validateItem(value, index, artifactRoles) {
  const label = `packet.items[${index}]`;
  const item = requireObject(value, label);
  const allowedKeys = ["category", "statement", "context", "attribution", "settlement", "chronology", "evidence"];
  const requiredKeys = ["category", "statement", "context", "settlement", "chronology", "evidence"];
  requireAllowedKeys(item, allowedKeys, label);
  requireKeys(item, requiredKeys, label);

  requireEnum(item.category, ITEM_CATEGORIES, `${label}.category`);
  requireString(item.statement, `${label}.statement`, 1, 600);
  requireString(item.context, `${label}.context`, 1, 1000);
  if ("attribution" in item) {
    requireString(item.attribution, `${label}.attribution`, 1, 160);
  }

  const settlement = requireObject(item.settlement, `${label}.settlement`);
  requireAllowedKeys(settlement, ["status", "basis"], `${label}.settlement`);
  requireKeys(settlement, ["status", "basis"], `${label}.settlement`);
  requireEnum(settlement.status, SETTLEMENT_STATUSES, `${label}.settlement.status`);
  requireEnum(settlement.basis, SETTLEMENT_BASES, `${label}.settlement.basis`);
  if (settlement.status === "confirmed" && !STRONG_SETTLEMENT_BASES.has(settlement.basis)) {
    fail(`${label} uses a weak settlement basis for a confirmed item.`);
  }

  const chronology = requireObject(item.chronology, `${label}.chronology`);
  requireAllowedKeys(chronology, ["later_override_checked", "overridden_items_excluded"], `${label}.chronology`);
  requireKeys(chronology, ["later_override_checked", "overridden_items_excluded"], `${label}.chronology`);
  requireBoolean(chronology.later_override_checked, `${label}.chronology.later_override_checked`);
  requireBoolean(chronology.overridden_items_excluded, `${label}.chronology.overridden_items_excluded`);
  if (!chronology.later_override_checked || !chronology.overridden_items_excluded) {
    fail(`${label} has incomplete later-override gates.`);
  }

  if (!Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 3) {
    fail(`${label}.evidence must contain between 1 and 3 items.`);
  }
  const citedSourceRoles = new Set();
  for (let evidenceIndex = 0; evidenceIndex < item.evidence.length; evidenceIndex += 1) {
    const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
    const evidence = requireObject(item.evidence[evidenceIndex], evidenceLabel);
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

  return item;
}

export function validateMeetingAnalysisPacket(bundleInput, packetInput) {
  const prepared = validateArtifactBundle(bundleInput);
  const packet = requireObject(packetInput, "packet");
  const keys = ["schema", "source_revision", "status", "reason", "items"];
  requireAllowedKeys(packet, keys, "packet");
  requireKeys(packet, keys, "packet");
  if (packet.schema !== "synthesize-meeting-records.meeting-analysis-packet.v1") {
    fail("packet.schema is unsupported.");
  }
  if (packet.source_revision !== prepared.source_revision) {
    fail("packet.source_revision does not match the supplied artifact bundle.");
  }
  requireEnum(packet.status, PACKET_STATUSES, "packet.status");
  requireString(packet.reason, "packet.reason", 1, 400);
  if (!Array.isArray(packet.items) || packet.items.length > 12) {
    fail("packet.items must be an array with at most 12 items.");
  }

  const artifactRoles = new Map(
    prepared.bundle.artifacts.map((artifact) => [artifact.artifact_id, artifact.source_role]),
  );
  const items = packet.items.map((item, index) => validateItem(item, index, artifactRoles));

  if (packet.status === "blocked-source") {
    if (prepared.source_status !== "blocked-source") {
      fail("blocked-source requires an incomplete or unclassifiable artifact.");
    }
    if (items.length !== 0) fail("blocked-source requires zero items.");
  } else if (prepared.source_status !== "complete") {
    fail(`${packet.status} requires every artifact to be complete and safely classified.`);
  }

  if (packet.status === "no-findings" && items.length !== 0) {
    fail("no-findings requires zero items.");
  }

  if (packet.status === "needs-confirmation") {
    if (items.length === 0 || !items.some((item) => item.settlement.status === "uncertain")) {
      fail("needs-confirmation requires at least one uncertain item.");
    }
  }

  if (packet.status === "complete") {
    if (items.length === 0) fail("complete requires at least one item.");
    for (const [index, item] of items.entries()) {
      if (item.settlement.status !== "confirmed") {
        fail(`packet.items[${index}] must be confirmed for complete.`);
      }
    }
  }

  scanPrivateOutput(packet);
  return { packet, source_revision: prepared.source_revision };
}
