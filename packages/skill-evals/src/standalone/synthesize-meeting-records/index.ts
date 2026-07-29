import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SYNTHESIZE_MEETING_RECORDS_CASES } from "./cases.js";
import { runSynthesizeMeetingRecordsCase } from "./runner.js";
import { buildBatchSummary, formatSummaryTable } from "./summary.js";
import type { CliOptions, MeetingRecordsEvalCase } from "./types.js";

function usage(): string {
  return `Usage:
  pnpm --filter @first-tree/skill-evals eval:standalone:synthesize-meeting-records
  pnpm --filter @first-tree/skill-evals eval:standalone:synthesize-meeting-records -- --case <id>

This is a human-directed model-backed evaluation. Do not run it implicitly.
This standalone gate runs Codex on Linux only because the host must contain
and reap the complete model process tree. The Skill contract itself remains
provider-agnostic.

Options:
  --case <id>            Run one case.
  --model <model>        Model override.
  --codex-bin <path>     Codex binary. Defaults to CODEX_BIN or codex.
  --json                 Print JSON instead of a table.
  --verbose              Print live progress.
  --help                 Show this help.
`;
}

function readOptionValue(args: readonly string[], index: number, optionName: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value.`);
  return value;
}

export function parseArgs(args: readonly string[]): CliOptions {
  const normalized = args.filter((arg) => arg !== "--");
  const options: CliOptions = {
    caseId: null,
    codexBin: process.env.CODEX_BIN ?? "codex",
    json: false,
    model: process.env.CODEX_MODEL ?? null,
    verbose: false,
  };
  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--case") {
      options.caseId = readOptionValue(normalized, index, "--case");
      index += 1;
      continue;
    }
    if (arg === "--model") {
      options.model = readOptionValue(normalized, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--codex-bin") {
      options.codexBin = readOptionValue(normalized, index, "--codex-bin");
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux") {
    throw new Error("The standalone synthesize-meeting-records gate requires Linux process-tree containment.");
  }
}

function selectCases(caseId: string | null): readonly MeetingRecordsEvalCase[] {
  if (caseId === null) return SYNTHESIZE_MEETING_RECORDS_CASES;
  const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.id === caseId);
  if (evalCase !== undefined) return [evalCase];
  throw new Error(
    `Unknown synthesize-meeting-records case '${caseId}'. Available cases: ${SYNTHESIZE_MEETING_RECORDS_CASES.map(
      (candidate) => candidate.id,
    ).join(", ")}`,
  );
}

export async function main(args: readonly string[]): Promise<number> {
  const options = parseArgs(args);
  assertSupportedPlatform();
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const runStartedAt = new Date().toISOString();
  const summaries = [];
  for (const evalCase of selectCases(options.caseId)) {
    if (!options.verbose) process.stderr.write(`Running standalone meeting eval case: ${evalCase.id}\n`);
    summaries.push(await runSynthesizeMeetingRecordsCase(packageRoot, evalCase, options, runStartedAt));
  }
  const batch = buildBatchSummary(summaries, runStartedAt);
  process.stdout.write(options.json ? `${JSON.stringify(batch, null, 2)}\n` : `${formatSummaryTable(batch)}\n`);
  return batch.failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
