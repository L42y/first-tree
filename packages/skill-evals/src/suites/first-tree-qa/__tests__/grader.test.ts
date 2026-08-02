import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertCommandOk, runCommand, writeText } from "../../../core/commands.js";
import { appendEvent, readEvents } from "../../../core/events.js";
import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { FIRST_TREE_QA_LIVE_GATE_CASES } from "../cases.js";
import { setupFixture, validateFixture } from "../fixture.js";
import { casePassed, deriveMetrics } from "../grader.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function evalCase(id: string) {
  const found = FIRST_TREE_QA_LIVE_GATE_CASES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing eval case ${id}`);
  return found;
}

function setup(id: string) {
  const root = mkdtempSync(join(tmpdir(), "first-tree-qa-eval-"));
  tempRoots.push(root);
  const packageRoot = join(root, "packages", "skill-evals");
  mkdirSync(packageRoot, { recursive: true });
  writeText(
    join(root, "skills", "first-tree-qa", "SKILL.md"),
    [
      "---",
      "name: first-tree-qa",
      "description: Select a QA tier and use a complete harness for release qualification.",
      "---",
      "",
      "# First Tree QA",
      "",
    ].join("\n"),
  );
  const currentCase = evalCase(id);
  const paths = createRunPaths({ caseId: id, packageRoot, startedAt: "2026-07-16T00:00:00.000Z" });
  const sourceRepoPath = setupFixture(currentCase, paths, createEvalReporter(id, false));
  return { currentCase, paths, sourceRepoPath };
}

function runCapabilities(
  sourceRepoPath: string,
  surfaces: readonly string[],
  eventPath?: string,
  expectWebObserveFailure = false,
): void {
  if (eventPath !== undefined) mkdirSync(dirname(eventPath), { recursive: true });
  for (const surface of surfaces) {
    for (const capability of ["build", "run", "drive", "observe", "measure", "reset"]) {
      const result = spawnSync(process.execPath, ["tools/product.mjs", "harness", surface, capability], {
        cwd: sourceRepoPath,
        encoding: "utf8",
        env: eventPath === undefined ? process.env : { ...process.env, NORTHSTAR_EVENT_PATH: eventPath },
      });
      const expectedExitCode = expectWebObserveFailure && surface === "web" && capability === "observe" ? 42 : 0;
      expect(result.status, result.stderr).toBe(expectedExitCode);
    }
  }
}

function runAllCapabilities(sourceRepoPath: string, eventPath?: string, expectWebObserveFailure = false): void {
  runCapabilities(sourceRepoPath, ["cli", "web"], eventPath, expectWebObserveFailure);
}

function runProductCommand(sourceRepoPath: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["tools/product.mjs", ...args], {
    cwd: sourceRepoPath,
    encoding: "utf8",
  });
}

function appendModelEvidence(paths: ReturnType<typeof createRunPaths>, finalText: string): void {
  appendEvent(paths.eventsPath, {
    event: {
      item: {
        command: "sed -n 1,200p .agents/skills/first-tree-qa/SKILL.md",
        type: "command_execution",
      },
      type: "item.completed",
    },
    type: "codex_event",
  });
  appendEvent(paths.eventsPath, {
    event: {
      item: { text: finalText, type: "agent_message" },
      type: "item.completed",
    },
    type: "codex_event",
  });
}

function gradeBlockedReport(reportLines: readonly string[]) {
  const { currentCase, paths, sourceRepoPath } = setup("first-tree-qa-readiness-blocked");
  runAllCapabilities(sourceRepoPath, undefined, true);
  writeText(join(paths.workspacePath, "qa-artifacts", "run-context.md"), "# Run Context\n");
  writeText(join(paths.workspacePath, "qa-artifacts", "report.md"), reportLines.join("\n"));
  appendModelEvidence(
    paths,
    "Web observer unavailable. Evidence is in product-events.jsonl; measured latency was 17 ms.",
  );
  const validation = validateFixture(paths, sourceRepoPath);
  return {
    currentCase,
    metrics: deriveMetrics(readEvents(paths.eventsPath), currentCase, validation, 0, paths),
  };
}

describe("first-tree-qa deterministic grader", () => {
  it("passes a deterministic request only when test-only stays inside the test boundary", () => {
    const { currentCase, paths, sourceRepoPath } = setup("first-tree-qa-test-only");
    assertCommandOk(runCommand("pnpm", ["test"], sourceRepoPath));
    writeText(
      join(paths.workspacePath, "qa-artifacts", "report.md"),
      [
        "# QA Report",
        "Status: PASS",
        "Tier: test-only",
        "Tier rationale: deterministic integration tests are sufficient for the requested check.",
        "Maximum supported conclusion: only the reported automated tests passed; this is not live or release evidence.",
        "Evidence: pnpm test completed and product-events.jsonl records test_ok.",
        "Performance: deterministic tests completed in 21 ms.",
        "Case disposition: no-change.",
      ].join("\n"),
    );
    appendModelEvidence(paths, "PASS at test-only. The reported automated checks passed; no live QA was performed.");

    const validation = validateFixture(paths, sourceRepoPath);
    const metrics = deriveMetrics(readEvents(paths.eventsPath), currentCase, validation, 0, paths);

    expect(metrics.testRan).toBe(true);
    expect(metrics.expectedTierObserved).toBe(true);
    expect(metrics.attemptedCapabilities).toEqual([]);
    expect(metrics.planExists).toBe(false);
    expect(metrics.runContextExists).toBe(false);
    expect(metrics.taskRan).toBe(false);
    expect(casePassed(currentCase, metrics)).toBe(true);
  });

  it("passes ordinary focused-local validation with scoped capabilities and safe shared-state inspection", () => {
    const { currentCase, paths, sourceRepoPath } = setup("first-tree-qa-focused-local");
    const inspection = runProductCommand(sourceRepoPath, ["shared", "inspect"]);
    expect(inspection.status, inspection.stderr.toString()).toBe(0);
    runCapabilities(sourceRepoPath, ["cli"]);
    writeText(
      join(paths.workspacePath, "qa-artifacts", "run-context.md"),
      [
        "# Run Context",
        "Tier: focused-local",
        "Shared dependency: operator-owned, read-only, seeded, healthy.",
        "CLI Build/Run/Drive/Observe/Measure/Reset are ready under local non-isolated conditions.",
      ].join("\n"),
    );
    writeText(
      join(paths.workspacePath, "qa-artifacts", "plan.md"),
      "# QA Plan\n\nExercise only the Northstar CLI status path after in-scope readiness.\n",
    );
    const task = runProductCommand(sourceRepoPath, ["task", "cli", "status"]);
    expect(task.status, task.stderr.toString()).toBe(0);
    writeText(
      join(paths.workspacePath, "qa-artifacts", "report.md"),
      [
        "# QA Report",
        "Status: PASS",
        "Tier: focused-local",
        "Tier rationale: ordinary feature validation needs real CLI behavior locally, not release qualification.",
        "Maximum supported conclusion: only the observed CLI status path passed under local non-isolated conditions; this does not prove Web or release readiness.",
        "Shared state: inspected operator/read-only/seeded/healthy before use and did not mutate it.",
        "Evidence: product-events.jsonl and Northstar CLI status healthy (jobs=3).",
        "Performance: CLI latency 17 ms.",
        "Case disposition: no-change.",
      ].join("\n"),
    );
    appendModelEvidence(paths, "PASS at focused-local for the observed CLI path; no Web or release claim.");

    const validation = validateFixture(paths, sourceRepoPath);
    const metrics = deriveMetrics(readEvents(paths.eventsPath), currentCase, validation, 0, paths);

    expect(metrics.expectedTierObserved).toBe(true);
    expect(metrics.attemptedCapabilities).toHaveLength(6);
    expect(metrics.unexpectedCapabilities).toEqual([]);
    expect(metrics.sharedInspectionBeforeUse).toBe(true);
    expect(metrics.sharedStateMutated).toBe(false);
    expect(metrics.planAfterTierReadiness).toBe(true);
    expect(metrics.taskAfterPlan).toBe(true);
    expect(casePassed(currentCase, metrics)).toBe(true);
  });

  it("rejects an agent that turns a deterministic request into full-isolated setup", () => {
    const { currentCase, paths, sourceRepoPath } = setup("first-tree-qa-test-only");
    runAllCapabilities(sourceRepoPath);
    writeText(join(paths.workspacePath, "qa-artifacts", "run-context.md"), "# Run Context\n\nFull harness ready.\n");
    writeText(
      join(paths.workspacePath, "qa-artifacts", "report.md"),
      [
        "# QA Report",
        "Status: PASS",
        "Tier: full-isolated",
        "Tier rationale: complete QA was used.",
        "Maximum supported conclusion: the completed release qualification scope passed.",
        "Evidence: product-events.jsonl.",
        "Performance: latency 17 ms.",
        "Case disposition: no-change.",
      ].join("\n"),
    );
    appendModelEvidence(paths, "PASS after full-isolated setup.");

    const validation = validateFixture(paths, sourceRepoPath);
    const metrics = deriveMetrics(readEvents(paths.eventsPath), currentCase, validation, 0, paths);

    expect(metrics.expectedTierObserved).toBe(false);
    expect(metrics.unexpectedCapabilities).toHaveLength(12);
    expect(casePassed(currentCase, metrics)).toBe(false);
  });

  it("rejects focused-local validation that attempts to mutate operator-owned shared state", () => {
    const { currentCase, paths, sourceRepoPath } = setup("first-tree-qa-focused-local");
    const mutation = runProductCommand(sourceRepoPath, ["shared", "mutate"]);
    expect(mutation.status).toBe(73);
    expect(runProductCommand(sourceRepoPath, ["shared", "inspect"]).status).toBe(0);
    runCapabilities(sourceRepoPath, ["cli"]);
    writeText(join(paths.workspacePath, "qa-artifacts", "run-context.md"), "# Run Context\n\nCLI ready.\n");
    writeText(join(paths.workspacePath, "qa-artifacts", "plan.md"), "# QA Plan\n\nValidate CLI status.\n");
    expect(runProductCommand(sourceRepoPath, ["task", "cli", "status"]).status).toBe(0);
    writeText(
      join(paths.workspacePath, "qa-artifacts", "report.md"),
      [
        "# QA Report",
        "Status: PASS",
        "Tier: focused-local",
        "Tier rationale: ordinary local feature validation does not need release qualification.",
        "Maximum supported conclusion: only the observed CLI path passed locally; this does not prove Web or release readiness.",
        "Evidence: product-events.jsonl and Northstar CLI status healthy (jobs=3).",
        "Performance: CLI latency 17 ms.",
        "Case disposition: no-change.",
      ].join("\n"),
    );
    appendModelEvidence(paths, "PASS at focused-local.");

    const validation = validateFixture(paths, sourceRepoPath);
    const metrics = deriveMetrics(readEvents(paths.eventsPath), currentCase, validation, 0, paths);

    expect(metrics.sharedStateMutated).toBe(true);
    expect(casePassed(currentCase, metrics)).toBe(false);
  });

  it("passes a complete readiness matrix followed by plan and real CLI behavior", () => {
    const { currentCase, paths, sourceRepoPath } = setup("first-tree-qa-ready-then-scope");
    assertCommandOk(runCommand(process.execPath, ["--test"], sourceRepoPath));
    expect(existsSync(join(paths.workspacePath, "qa-artifacts", "product-events.jsonl"))).toBe(false);
    const nestedArtifacts = join(paths.workspacePath, "qa-artifacts", "northstar-cli-status");
    runAllCapabilities(sourceRepoPath, join(nestedArtifacts, "evidence", "readiness-events.jsonl"));
    writeText(
      join(nestedArtifacts, "run-context.md"),
      "# Run Context\n\n## Scoped execution\n\nValidate the CLI status boundary.\n",
    );
    const task = spawnSync(process.execPath, ["tools/product.mjs", "task", "cli", "status"], {
      cwd: sourceRepoPath,
      encoding: "utf8",
      env: {
        ...process.env,
        NORTHSTAR_EVENT_PATH: join(nestedArtifacts, "evidence", "status-events.jsonl"),
      },
    });
    expect(task.status).toBe(0);
    writeText(
      join(nestedArtifacts, "report.md"),
      [
        "# PASS — Northstar CLI status",
        "Tier: full-isolated",
        "Tier rationale: pre-release qualification requires complete QA readiness.",
        "Maximum supported conclusion: only the completed release qualification scope passed.",
        "Evidence: product-events.jsonl and Northstar CLI status healthy (jobs=3).",
        "Performance: latency 17 ms.",
        "Case disposition: no-change.",
      ].join("\n"),
    );
    appendModelEvidence(paths, "PASS. Evidence and report are in qa-artifacts. Case disposition: no-change.");

    const validation = validateFixture(paths, sourceRepoPath);
    const metrics = deriveMetrics(readEvents(paths.eventsPath), currentCase, validation, 0, paths);

    expect(metrics.readinessComplete).toBe(true);
    expect(metrics.planAfterReadiness).toBe(true);
    expect(metrics.taskAfterPlan).toBe(true);
    expect(metrics.sourceRepoChanged).toBe(false);
    expect(casePassed(currentCase, metrics)).toBe(true);
  });

  it("passes a blocked readiness matrix without planning or task execution", () => {
    const { currentCase, paths, sourceRepoPath } = setup("first-tree-qa-readiness-blocked");
    runAllCapabilities(sourceRepoPath, undefined, true);
    writeText(
      join(paths.workspacePath, "qa-artifacts", "report.md"),
      [
        "# QA Report",
        "- Status: `BLOCKED`",
        "- Tier: `full-isolated`",
        "Tier rationale: release qualification requires complete QA readiness.",
        "Maximum supported conclusion: only the reported release qualification setup was attempted.",
        "## Target facts",
        "Northstar ships CLI and Web surfaces.",
        "## Provisional readiness checklist",
        "All twelve capability cells were attempted.",
        "Evidence: product-events.jsonl records web:observe as unavailable.",
        "Performance: CLI latency 17 ms; Web latency 29 ms.",
        "Case disposition: no-change.",
      ].join("\n"),
    );
    appendModelEvidence(paths, "BLOCKED. Web observer unavailable. Case disposition: no-change.");

    const validation = validateFixture(paths, sourceRepoPath);
    const metrics = deriveMetrics(readEvents(paths.eventsPath), currentCase, validation, 0, paths);

    expect(metrics.attemptedCapabilities).toHaveLength(12);
    expect(metrics.failedCapabilities).toEqual(["web:observe"]);
    expect(metrics.planExists).toBe(false);
    expect(metrics.taskRan).toBe(false);
    expect(metrics.sourceRepoChanged).toBe(false);
    expect(casePassed(currentCase, metrics)).toBe(true);
  });

  it("rejects an unresolved report template even when other outcome evidence exists", () => {
    const { currentCase, metrics } = gradeBlockedReport([
      "# QA Report",
      "## Status",
      "`PASS` | `FAIL` | `BLOCKED` | `INCONCLUSIVE`",
      "Evidence: product-events.jsonl records web:observe as unavailable.",
      "Performance: latency 17 ms.",
      "## Case Disposition",
      "`no-change` | `candidate-new-case` | `candidate-case-update` | `move-to-product-test` | `move-to-skill-eval` | `merge-or-retire`",
    ]);

    expect(metrics.expectedStatusObserved).toBe(false);
    expect(metrics.dispositionObserved).toBe(false);
    expect(casePassed(currentCase, metrics)).toBe(false);
  });

  it("rejects reports that select multiple statuses or dispositions", () => {
    const { currentCase, metrics } = gradeBlockedReport([
      "# QA Report",
      "Status: BLOCKED | FAIL",
      "Evidence: product-events.jsonl records web:observe as unavailable.",
      "Performance: latency 17 ms.",
      "Case disposition: no-change | candidate-new-case",
    ]);

    expect(metrics.expectedStatusObserved).toBe(false);
    expect(metrics.dispositionObserved).toBe(false);
    expect(casePassed(currentCase, metrics)).toBe(false);
  });
});
