import { RETURN_MEETING_CONTEXT_GATE_CASES } from "./cases.js";
import { runReturnMeetingContextCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { BatchSummary, CliOptions, ReturnMeetingContextEvalCase } from "./types.js";

export function findReturnMeetingContextCase(id: string): ReturnMeetingContextEvalCase | null {
  return RETURN_MEETING_CONTEXT_GATE_CASES.find((evalCase) => evalCase.id === id) ?? null;
}

function selectCases(caseId: string | null): readonly ReturnMeetingContextEvalCase[] {
  if (caseId === null) return RETURN_MEETING_CONTEXT_GATE_CASES;
  const evalCase = findReturnMeetingContextCase(caseId);
  if (evalCase !== null) return [evalCase];
  throw new Error(
    "Unknown return-meeting-context case '" +
      caseId +
      "'. Available cases: " +
      RETURN_MEETING_CONTEXT_GATE_CASES.map((candidate) => candidate.id).join(", "),
  );
}

export async function runReturnMeetingContextGate(packageRoot: string, options: CliOptions): Promise<BatchSummary> {
  const selectedCases = selectCases(options.caseId);
  const runStartedAt = new Date().toISOString();
  const summaries = [];
  for (const evalCase of selectedCases) {
    if (!options.verbose) process.stderr.write(`Running return-meeting-context eval case: ${evalCase.id}\n`);
    summaries.push(await runReturnMeetingContextCase(packageRoot, evalCase, options, runStartedAt));
  }
  return buildBatchSummary(summaries, runStartedAt);
}

export function formatReturnMeetingContextGateSummary(batch: BatchSummary): string {
  return formatSummaryTable(batch);
}
