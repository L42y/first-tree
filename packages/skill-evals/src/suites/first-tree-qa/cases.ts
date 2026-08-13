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
      status: "PASS",
      taskShouldRun: false,
      tier: "test-only",
    },
    fixture: { mode: "test-only" },
    id: "first-tree-qa-test-only",
    prompt: "Use first-tree-qa to run Northstar's requested deterministic integration tests.",
    provider: "codex",
    skill: "first-tree-qa",
    status: "implemented",
    tags: ["test-only", "tier-selection", "deterministic-tests", "scope-limit"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      disposition: "no-change",
      planShouldExist: true,
      status: "PASS",
      taskShouldRun: true,
      tier: "focused-local",
    },
    fixture: { mode: "focused-local" },
    id: "first-tree-qa-focused-local",
    prompt:
      "Use first-tree-qa to validate Northstar CLI status as ordinary local feature validation, not release qualification.",
    provider: "codex",
    skill: "first-tree-qa",
    status: "implemented",
    tags: ["focused-local", "tier-selection", "warm-environment", "shared-state-safety", "scope-limit"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      disposition: "no-change",
      planShouldExist: false,
      status: "BLOCKED",
      taskShouldRun: false,
      tier: "full-isolated",
    },
    fixture: { mode: "readiness-blocked" },
    id: "first-tree-qa-readiness-blocked",
    prompt:
      "Use first-tree-qa to validate Northstar's high-risk CLI status release path in an isolated environment. The requested scope is CLI only; Web is unrelated.",
    provider: "codex",
    skill: "first-tree-qa",
    status: "implemented",
    tags: ["full-isolated", "risk-scoped", "warm-environment", "readiness-gate"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      disposition: "no-change",
      planShouldExist: true,
      status: "PASS",
      taskShouldRun: true,
      tier: "full-isolated",
    },
    fixture: { mode: "ready" },
    id: "first-tree-qa-ready-then-scope",
    prompt:
      "Use first-tree-qa to validate Northstar's high-risk CLI status release path in an isolated environment. The requested scope is CLI only; Web is unrelated.",
    provider: "codex",
    skill: "first-tree-qa",
    status: "implemented",
    tags: ["full-isolated", "risk-scoped", "warm-environment", "task-scope", "performance"],
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
  const expectedGateIds = [
    "first-tree-qa-test-only",
    "first-tree-qa-focused-local",
    "first-tree-qa-readiness-blocked",
    "first-tree-qa-ready-then-scope",
  ];
  if (JSON.stringify(gateIds) !== JSON.stringify(expectedGateIds)) {
    errors.push("gate coverage must declare lower-tier selection and scoped full-isolated readiness cases");
  }

  const skill = readRepoFile("skills/first-tree-qa/SKILL.md");
  const packageInstructions = readRepoFile("packages/qa/AGENTS.md");
  const environment = readRepoFile("packages/qa/environment/README.md");
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
  if (!planTemplate.includes("selected isolated scope is `QA READY`")) {
    errors.push("QA plan template must gate full-isolated planning on scoped readiness");
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
  const combined = [skill, packageInstructions, environment, planTemplate].join("\n");
  for (const marker of [
    /one QA-owned warm environment/iu,
    /reuse the same task (?:environment|slot)/iu,
    /reset task-owned/iu,
    /retain compatible infrastructure/iu,
    /affected surfaces and critical adjacent boundaries/iu,
  ]) {
    if (!marker.test(combined)) errors.push("QA reuse and risk-scoping contract is incomplete");
  }
  if (
    /First make the whole product testable|complete harness before scoping execution|complete disposable Docker/iu.test(
      combined,
    )
  ) {
    errors.push("superseded universal or disposable harness language remains");
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
          "Skill metadata, tiered lifecycle, risk-scoped breadth, warm-environment reuse, and case disposition contract.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: FIRST_TREE_QA_LIVE_GATE_CASES.map((evalCase) => evalCase.id),
        description:
          "Behavioral tier selection, observable warm-environment lifecycle, and scoped full-isolated readiness.",
        status: "implemented",
        tier: "gate",
      },
    ],
  },
  skill: "first-tree-qa",
  validateFloor: validateFirstTreeQaFloor,
};
