import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import type { FirstTreeQaEvalCase } from "./types.js";
import { QA_CAPABILITIES, QA_SURFACES } from "./types.js";

const FLOOR_CASE_ID = "first-tree-qa-contract-floor";

export const FIRST_TREE_QA_LIVE_GATE_CASES: readonly FirstTreeQaEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      disposition: "no-change",
      planShouldExist: false,
      status: "BLOCKED",
      taskShouldRun: false,
    },
    fixture: { mode: "readiness-blocked" },
    id: "first-tree-qa-readiness-blocked",
    prompt:
      "Use first-tree-qa to perform pre-release qualification of Northstar, focusing execution on CLI status behavior.",
    provider: "codex",
    skill: "first-tree-qa",
    status: "implemented",
    tags: ["full-isolated", "release-qualification", "readiness-gate"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      disposition: "no-change",
      planShouldExist: true,
      status: "PASS",
      taskShouldRun: true,
    },
    fixture: { mode: "ready" },
    id: "first-tree-qa-ready-then-scope",
    prompt:
      "Use first-tree-qa to perform pre-release qualification of Northstar, focusing execution on CLI status behavior.",
    provider: "codex",
    skill: "first-tree-qa",
    status: "implemented",
    tags: ["full-isolated", "release-qualification", "task-scope", "performance"],
    tier: "gate",
  },
];

export const FIRST_TREE_QA_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      gateCaseIds: FIRST_TREE_QA_LIVE_GATE_CASES.map((evalCase) => evalCase.id),
      lifecycle: ["classify", "prepare", "scope", "execute", "report"],
    },
    fixture: {
      capabilities: QA_CAPABILITIES,
      surfaces: QA_SURFACES,
    },
    id: FLOOR_CASE_ID,
    skill: "first-tree-qa",
    status: "implemented",
    tier: "floor",
  },
  ...FIRST_TREE_QA_LIVE_GATE_CASES,
];

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
}

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot(), path), "utf8");
}

export function validateFirstTreeQaFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  const floor = cases.find((evalCase) => evalCase.id === FLOOR_CASE_ID);
  if (floor === undefined) errors.push("missing first-tree-qa floor case");

  const gateIds = cases.filter((evalCase) => evalCase.tier === "gate").map((evalCase) => evalCase.id);
  const expectedGateIds = FIRST_TREE_QA_LIVE_GATE_CASES.map((evalCase) => evalCase.id);
  if (JSON.stringify(gateIds) !== JSON.stringify(expectedGateIds)) {
    errors.push("gate coverage must declare the readiness-blocked and ready-then-scope cases");
  }

  const skill = readRepoFile("skills/first-tree-qa/SKILL.md");
  const packageInstructions = readRepoFile("packages/qa/AGENTS.md");
  const planTemplate = readRepoFile("packages/qa/templates/qa-plan.md");
  const reportTemplate = readRepoFile("packages/qa/templates/qa-report.md");
  const requiredSkillMarkers = [
    "### 1. Understand and classify",
    "### 2. Prepare the selected tier",
    "### 3. Scope and record",
    "### 4. Execute and adapt",
    "### 5. Report and improve the quality system",
  ];
  let previous = -1;
  for (const marker of requiredSkillMarkers) {
    const current = skill.indexOf(marker);
    if (current <= previous) errors.push("skill lifecycle markers are missing or out of order");
    previous = current;
  }
  if (!/The skill owns\s+the core QA principles and lifecycle/u.test(packageInstructions)) {
    errors.push("QA package must declare the skill-owned lifecycle boundary");
  }
  for (const tier of ["test-only", "focused-local", "full-isolated"]) {
    if (!skill.includes(`\`${tier}\``) || !packageInstructions.includes(`\`${tier}\``)) {
      errors.push("skill and package must declare all QA execution tiers");
      break;
    }
  }
  if (!planTemplate.includes("Create for `focused-local` only after its in-scope capabilities are ready.")) {
    errors.push("QA plan template must gate focused-local planning on in-scope capabilities");
  }
  if (!planTemplate.includes("Create for `full-isolated` only after the")) {
    errors.push("QA plan template must gate full-isolated planning on complete readiness");
  }
  if (!planTemplate.includes("Do not create for `test-only`.")) {
    errors.push("QA plan template must keep test-only free of formal planning");
  }
  for (const disposition of [
    "no-change",
    "candidate-new-case",
    "candidate-case-update",
    "move-to-product-test",
    "move-to-skill-eval",
    "merge-or-retire",
  ]) {
    if (!skill.includes(disposition) || !reportTemplate.includes(disposition)) {
      errors.push("skill and package report template must share all case dispositions");
      break;
    }
  }
  const combined = [skill, packageInstructions, planTemplate].join("\n");
  if (/First make the whole product testable|complete harness before scoping execution/iu.test(combined)) {
    errors.push("superseded universal complete-harness language remains");
  }
  return [...new Set(errors)];
}

export const FIRST_TREE_QA_SUITE: SkillEvalSuiteDefinition = {
  cases: FIRST_TREE_QA_EVAL_CASES,
  coverage: {
    skill: "first-tree-qa",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description:
          "Skill metadata, tiered lifecycle, package boundary, capability matrix, and case disposition contract.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: FIRST_TREE_QA_LIVE_GATE_CASES.map((evalCase) => evalCase.id),
        description: "Full-isolated release readiness failure and QA READY before task scoping.",
        status: "implemented",
        tier: "gate",
      },
    ],
  },
  skill: "first-tree-qa",
  validateFloor: validateFirstTreeQaFloor,
};
