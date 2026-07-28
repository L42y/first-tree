import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import type { ReturnMeetingContextEvalCase } from "./types.js";

const FLOOR_CASE_ID = "return-meeting-context-contract-floor";

export const RETURN_MEETING_CONTEXT_GATE_CASES: readonly ReturnMeetingContextEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      candidateCount: 0,
      forbiddenClaimTerms: ["ship date", "task owner"],
      handoff: "none",
      requiredClaimTerms: [],
      settlement: "none",
      status: "no-change",
    },
    fixture: { mode: "progress-only", routing: "single-skill" },
    id: "meeting-progress-only-no-change",
    prompt:
      "Use return-meeting-context to analyze source-artifacts/bundle.json. Write the validated packet to meeting-context-output.json. Do not create or modify a Context Tree.",
    provider: "codex",
    skill: "return-meeting-context",
    status: "implemented",
    tags: ["no-change", "durability"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      candidateCount: 1,
      forbiddenClaimTerms: ["calendar-owned ingestion", "option a"],
      handoff: "first-tree-write",
      requiredClaimTerms: ["user", "artifact", "provider"],
      settlement: "settled",
      status: "ready-for-write",
    },
    fixture: { mode: "later-override", routing: "meeting-vs-write" },
    id: "meeting-later-override-final-decision",
    prompt:
      "Reflect the durable decisions from the supplied meeting minutes at `source-artifacts/bundle.json` into the Context Tree.",
    provider: "codex",
    skill: "return-meeting-context",
    status: "implemented",
    tags: ["later-override", "settlement", "rationale"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      candidateCount: 1,
      forbiddenClaimTerms: [],
      handoff: "none",
      requiredClaimTerms: ["meeting", "index"],
      settlement: "uncertain",
      status: "needs-confirmation",
    },
    fixture: { mode: "ai-notes", routing: "single-skill" },
    id: "meeting-ai-notes-needs-confirmation",
    prompt:
      "Use return-meeting-context to analyze source-artifacts/bundle.json. Write the validated packet to meeting-context-output.json. Do not create or modify a Context Tree.",
    provider: "codex",
    skill: "return-meeting-context",
    status: "implemented",
    tags: ["settlement", "ai-notes"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      candidateCount: 0,
      forbiddenClaimTerms: [],
      handoff: "none",
      requiredClaimTerms: [],
      settlement: "none",
      status: "blocked-source",
    },
    fixture: { mode: "partial-source", routing: "single-skill" },
    id: "meeting-partial-source-blocked",
    prompt:
      "Use return-meeting-context to analyze source-artifacts/bundle.json. Write the validated packet to meeting-context-output.json. Do not create or modify a Context Tree.",
    provider: "codex",
    skill: "return-meeting-context",
    status: "implemented",
    tags: ["completeness", "fail-closed"],
    tier: "gate",
  },
];

export const RETURN_MEETING_CONTEXT_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      gateCaseIds: RETURN_MEETING_CONTEXT_GATE_CASES.map((evalCase) => evalCase.id),
      statuses: ["no-change", "needs-confirmation", "ready-for-write", "blocked-source"],
    },
    fixture: {
      inputKinds: ["provider_link", "attachment", "local_file", "pasted_text"],
      sourceRoles: ["human_minutes", "ai_notes", "transcript", "decision_record", "unknown"],
    },
    id: FLOOR_CASE_ID,
    skill: "return-meeting-context",
    status: "implemented",
    tier: "floor",
  },
  ...RETURN_MEETING_CONTEXT_GATE_CASES,
];

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
}

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot(), path), "utf8");
}

export function validateReturnMeetingContextFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  const floor = cases.find((evalCase) => evalCase.id === FLOOR_CASE_ID);
  if (floor === undefined) errors.push("missing return-meeting-context floor case");
  const gateIds = cases.filter((evalCase) => evalCase.tier === "gate").map((evalCase) => evalCase.id);
  const expectedGateIds = RETURN_MEETING_CONTEXT_GATE_CASES.map((evalCase) => evalCase.id);
  if (JSON.stringify(gateIds) !== JSON.stringify(expectedGateIds)) {
    errors.push("gate coverage must declare progress, override, AI-notes, and partial-source cases");
  }

  const skill = readRepoFile("skills/return-meeting-context/SKILL.md");
  for (const marker of [
    "Always use this skill first for meeting minutes",
    "Accept only artifacts the user explicitly provides",
    "Do not use a calendar",
    "AI-generated notes may identify a candidate but cannot alone prove human",
    "load `first-tree-write`",
    "Never maintain meeting discovery watermarks",
  ]) {
    if (!skill.includes(marker)) errors.push(`skill is missing required boundary: ${marker}`);
  }
  const writeSkill = readRepoFile("skills/first-tree-write/SKILL.md");
  for (const marker of [
    "Use when a concrete non-meeting source artifact",
    "use return-meeting-context first",
    "accepts them only with its validated DecisionEvidencePacket",
  ]) {
    if (!writeSkill.includes(marker)) errors.push(`first-tree-write is missing meeting routing boundary: ${marker}`);
  }
  for (const path of [
    "skills/return-meeting-context/scripts/prepare-artifacts.mjs",
    "skills/return-meeting-context/scripts/validate-output.mjs",
    "skills/return-meeting-context/references/meeting-artifact-bundle.schema.json",
    "skills/return-meeting-context/references/decision-evidence-packet.schema.json",
  ]) {
    if (!existsSync(join(repoRoot(), path))) errors.push(`missing contract artifact: ${path}`);
  }
  return errors;
}

export const RETURN_MEETING_CONTEXT_SUITE: SkillEvalSuiteDefinition = {
  cases: RETURN_MEETING_CONTEXT_EVAL_CASES,
  coverage: {
    skill: "return-meeting-context",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Input, source-strength, handoff, privacy, and validator contract.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: RETURN_MEETING_CONTEXT_GATE_CASES.map((evalCase) => evalCase.id),
        description: "Progress-only, later-override, AI settlement, and incomplete-source live behavior.",
        status: "implemented",
        tier: "gate",
      },
    ],
  },
  skill: "return-meeting-context",
  validateFloor: validateReturnMeetingContextFloor,
};
