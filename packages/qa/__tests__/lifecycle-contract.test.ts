import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

const dispositions = [
  "no-change",
  "candidate-new-case",
  "candidate-case-update",
  "move-to-product-test",
  "move-to-skill-eval",
  "merge-or-retire",
] as const;

describe("first-tree-qa lifecycle contract", () => {
  it("keeps the core lifecycle in the skill and First Tree details in the package", () => {
    const skill = readRepoFile("skills/first-tree-qa/SKILL.md");
    const packageInstructions = readRepoFile("packages/qa/AGENTS.md");

    expect(packageInstructions).toContain("The skill owns");
    expect(packageInstructions).toContain("repository-specific authority");
    expect(skill).toContain("repository-local QA instructions and assets");
    expect(skill).toMatch(/repository-specific tier\s+selection details/u);

    const phases = [
      "### 1. Understand and classify",
      "### 2. Prepare the selected tier",
      "### 3. Scope and record",
      "### 4. Execute and adapt",
      "### 5. Report and improve the quality system",
    ];
    let previous = -1;
    for (const phase of phases) {
      const current = skill.indexOf(phase);
      expect(current, `missing lifecycle phase: ${phase}`).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it("selects the lowest sufficient tier and scopes validation before setup", () => {
    const skill = readRepoFile("skills/first-tree-qa/SKILL.md");
    const packageInstructions = readRepoFile("packages/qa/AGENTS.md");
    const planTemplate = readRepoFile("packages/qa/templates/qa-plan.md");
    const combined = [skill, packageInstructions].join("\n");

    for (const tier of ["test-only", "focused-local", "full-isolated"]) {
      expect(combined).toContain(`\`${tier}\``);
    }
    expect(combined).toContain("Start with the lowest tier");
    expect(packageInstructions).toContain("matching package or named suite for a localized deterministic change");
    expect(packageInstructions).toContain("`full-isolated` strengthens isolation");
    expect(packageInstructions).toContain("Select affected surfaces and critical adjacent boundaries");
    expect(packageInstructions).toContain("Local non-isolated startup is allowed");
    expect(planTemplate).toContain("Create for `focused-local` only after its in-scope capabilities are ready.");
    expect(planTemplate).toContain("selected isolated scope is `QA READY`");
    expect(planTemplate).toContain("Do not create for `test-only`.");
  });

  it("reuses one QA-owned warm environment without retaining task-owned state", () => {
    const skill = readRepoFile("skills/first-tree-qa/SKILL.md");
    const packageInstructions = readRepoFile("packages/qa/AGENTS.md");
    const environment = readRepoFile("packages/qa/environment/README.md");
    const runContext = readRepoFile("packages/qa/templates/run-context.md");
    const combined = [skill, packageInstructions, environment].join("\n");

    expect(combined).toMatch(/one QA-owned warm environment/iu);
    expect(combined).toMatch(/reuse the same task (?:environment|slot)/iu);
    expect(combined).toMatch(/reset task-owned/iu);
    expect(combined).toMatch(/retain compatible infrastructure/iu);
    expect(runContext).toContain("Warm-environment ID/profile and task key");
    expect(runContext).toContain("Task reset owner and retained infrastructure");
  });

  it("keeps every case disposition aligned in the skill and report template", () => {
    const skill = readRepoFile("skills/first-tree-qa/SKILL.md");
    const reportTemplate = readRepoFile("packages/qa/templates/qa-report.md");

    for (const disposition of dispositions) {
      expect(skill).toContain(`\`${disposition}\``);
      expect(reportTemplate).toContain(`\`${disposition}\``);
    }
  });

  it("rejects the superseded universal and disposable harness contracts", () => {
    const files = [
      "skills/first-tree-qa/SKILL.md",
      "packages/qa/AGENTS.md",
      "packages/qa/README.md",
      "packages/qa/briefings/setup.md",
      "packages/qa/briefings/plan.md",
    ];
    const combined = files.map(readRepoFile).join("\n");

    expect(combined).not.toMatch(/First make the whole product testable/iu);
    expect(combined).not.toMatch(/A narrow request changes execution scope after readiness/iu);
    expect(combined).not.toMatch(/complete harness before scoping execution/iu);
    expect(combined).not.toMatch(/every shipped or publicly promised .*surface/iu);
    expect(combined).not.toMatch(/complete disposable Docker/iu);
  });
});
