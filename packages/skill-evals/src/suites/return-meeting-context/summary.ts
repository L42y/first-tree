import { writeFileSync } from "node:fs";

import { gradingMarkdownRows, writeGradingJson } from "../../core/grading.js";
import type { BatchSummary, CaseRunSummary } from "./types.js";

function fenced(value: string): string {
  return value.trim().length === 0 ? "_empty_" : `\n\`\`\`text\n${value}\n\`\`\``;
}

export function writeCaseSummaries(summary: CaseRunSummary): void {
  writeGradingJson(summary.gradingJsonPath, summary.grading);
  writeFileSync(summary.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const markdown = [
    `# ${summary.caseId}`,
    "",
    `- passed: ${String(summary.passed)}`,
    `- expectedStatus: ${summary.expectedAction}`,
    `- skillFileReadObserved: ${String(summary.metrics.skillFileReadObserved)}`,
    `- interpreterSkillReadOrder: ${String(summary.metrics.interpreterSkillReadOrder)}`,
    `- validatorInvocationOrder: ${String(summary.metrics.validatorInvocationOrder)}`,
    `- writerSkillReadOrder: ${String(summary.metrics.writerSkillReadOrder)}`,
    `- routingOrderObserved: ${String(summary.metrics.routingOrderObserved)}`,
    `- packetExists: ${String(summary.metrics.packetExists)}`,
    `- validatorSucceeded: ${String(summary.metrics.validatorSucceeded)}`,
    `- statusObserved: ${String(summary.metrics.statusObserved)}`,
    `- candidateCountObserved: ${String(summary.metrics.candidateCountObserved)}`,
    `- sourceRepoChanged: ${String(summary.metrics.sourceRepoChanged)}`,
    `- contextTreeCreated: ${String(summary.metrics.contextTreeCreated)}`,
    "",
    "## Grading",
    "",
    gradingMarkdownRows(summary.grading),
    "",
    "## Packet",
    "",
    fenced(summary.metrics.packetText),
    "",
    "## Final Response",
    "",
    fenced(summary.metrics.finalResponse),
    "",
    "## Validator",
    "",
    fenced(`${summary.metrics.validatorResult.stdout}\n${summary.metrics.validatorResult.stderr}`),
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
  return { cases, failed: cases.length - passed, passed, runStartedAt };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function formatSummaryTable(batch: BatchSummary): string {
  const header = ["case_id", "status", "packet", "validated", "source_clean", "tree_absent", "passed"];
  const rows = batch.cases.map((summary) => [
    summary.caseId,
    summary.expectedAction,
    String(summary.metrics.packetExists),
    String(summary.metrics.validatorSucceeded),
    String(!summary.metrics.sourceRepoChanged),
    String(!summary.metrics.contextTreeCreated),
    String(summary.passed),
  ]);
  const widths = header.map((label, index) => Math.max(label.length, ...rows.map((row) => row[index]?.length ?? 0)));
  return [
    header.map((label, index) => pad(label, widths[index] ?? label.length)).join("  "),
    ...rows.map((row) => row.map((value, index) => pad(value, widths[index] ?? value.length)).join("  ")),
  ].join("\n");
}
