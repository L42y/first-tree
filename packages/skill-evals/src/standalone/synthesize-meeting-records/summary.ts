import { writeFileSync } from "node:fs";

import type { BatchSummary, CaseRunSummary } from "./types.js";

function fenced(value: string): string {
  return value.trim().length === 0 ? "_empty_" : `\n\`\`\`text\n${value}\n\`\`\``;
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const markdown = [
    `# ${summary.caseId}`,
    "",
    `- passed: ${String(summary.passed)}`,
    `- statusObserved: ${String(summary.metrics.statusObserved)}`,
    `- skillFileReadObserved: ${String(summary.metrics.skillFileReadObserved)}`,
    `- validatorSucceeded: ${String(summary.metrics.validatorSucceeded)}`,
    `- sourceRepoChanged: ${String(summary.metrics.sourceRepoChanged)}`,
    `- contextTreeCreated: ${String(summary.metrics.contextTreeCreated)}`,
    `- runnerExitCode: ${String(summary.metrics.runnerExitCode)}`,
    "",
    "## Final Response",
    "",
    fenced(summary.metrics.finalResponse),
    "",
    "## Validator",
    "",
    fenced(`${summary.metrics.validatorResult.stderr}${summary.metrics.validatorResult.stdout}`),
    "",
    "## Paths",
    "",
    `- runRoot: ${summary.runRoot}`,
    `- workspacePath: ${summary.workspacePath}`,
    "",
  ].join("\n");
  writeFileSync(summary.summaryMdPath, markdown, "utf8");
}

export function buildBatchSummary(cases: readonly CaseRunSummary[], runStartedAt: string): BatchSummary {
  const passed = cases.filter((summary) => summary.passed).length;
  return {
    cases,
    failed: cases.length - passed,
    passed,
    runStartedAt,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function formatSummaryTable(batch: BatchSummary): string {
  const header = ["case_id", "status", "skill_read", "validator", "passed"];
  const rows = batch.cases.map((summary) => [
    summary.caseId,
    summary.metrics.statusObserved ? "expected" : "unexpected",
    String(summary.metrics.skillFileReadObserved),
    String(summary.metrics.validatorSucceeded),
    String(summary.passed),
  ]);
  const widths = header.map((label, index) => Math.max(label.length, ...rows.map((row) => row[index]?.length ?? 0)));
  return [
    header.map((label, index) => pad(label, widths[index] ?? label.length)).join("  "),
    ...rows.map((row) => row.map((value, index) => pad(value, widths[index] ?? value.length)).join("  ")),
  ].join("\n");
}
