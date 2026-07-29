import { join } from "node:path";

import { runCommand } from "../../core/commands.js";
import { appendEvent, readEvents } from "../../core/events.js";
import { createRunPaths } from "../../core/paths.js";
import { runCodexProvider } from "../../core/provider/codex.js";
import { createEvalReporter } from "../../core/reporter.js";
import {
  type PartialRawAccessMonitor,
  setupFixture,
  startPartialRawAccessMonitors,
  stopPartialRawAccessMonitors,
  validateFixture,
  validatePartialRawAccessMonitors,
} from "./fixture.js";
import { casePassed, deriveMetrics } from "./grader.js";
import { writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, MeetingRecordsEvalCase } from "./types.js";

export function runPacketValidator(paths: Parameters<typeof validateFixture>[0]) {
  return runCommand(
    "node",
    [
      join(paths.repoRoot, "skills", ".experimental", "synthesize-meeting-records", "scripts", "validate-output.mjs"),
      "--bundle",
      join(paths.workspacePath, "source-artifacts", "bundle.json"),
      "--output",
      join(paths.workspacePath, "meeting-analysis-output.json"),
    ],
    paths.workspacePath,
  );
}

export function finalizeFixtureValidationAfterAgent(
  paths: Parameters<typeof validateFixture>[0],
  sourceRepoPath: string,
  initialFixtureValidation: ReturnType<typeof validateFixture>,
  rawAccessMonitors: readonly PartialRawAccessMonitor[],
): ReturnType<typeof validateFixture> {
  let postRunFixtureValidation: ReturnType<typeof validateFixture> = {
    errors: [],
    ok: false,
    requiredFilesOk: false,
  };
  let rawAccessMonitorErrors: readonly string[] = [];
  try {
    try {
      postRunFixtureValidation = validateFixture(paths, sourceRepoPath);
    } catch (error) {
      postRunFixtureValidation = {
        errors: [`post-run fixture validation threw: ${error instanceof Error ? error.message : String(error)}`],
        ok: false,
        requiredFilesOk: false,
      };
    }
    try {
      rawAccessMonitorErrors = validatePartialRawAccessMonitors(paths, rawAccessMonitors);
    } catch (error) {
      rawAccessMonitorErrors = [
        `raw access monitor validation threw: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  } finally {
    stopPartialRawAccessMonitors(rawAccessMonitors);
  }

  const errors = [
    ...initialFixtureValidation.errors,
    ...postRunFixtureValidation.errors.map((error) => `post-run ${error}`),
    ...rawAccessMonitorErrors,
  ];
  return {
    errors,
    ok: errors.length === 0,
    requiredFilesOk: initialFixtureValidation.requiredFilesOk && postRunFixtureValidation.requiredFilesOk,
  };
}

export async function runSynthesizeMeetingRecordsCase(
  packageRoot: string,
  evalCase: MeetingRecordsEvalCase,
  options: CliOptions,
  runStartedAt: string,
): Promise<CaseRunSummary> {
  const startedAt = new Date().toISOString();
  const paths = createRunPaths({ caseId: evalCase.id, packageRoot, startedAt });
  const reporter = createEvalReporter(evalCase.id, options.verbose);
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    runStartedAt,
    type: "case_started",
  });
  reporter.caseStarted();

  const sourceRepoPath = setupFixture(evalCase, paths, reporter);
  const initialFixtureValidation = validateFixture(paths, sourceRepoPath);
  const rawAccessMonitors = await startPartialRawAccessMonitors(paths, sourceRepoPath);
  let fixtureValidation = initialFixtureValidation;
  const runnerResult = await (async () => {
    try {
      const exitCode = await runCodexProvider(
        {
          bin: options.codexBin,
          caseId: evalCase.id,
          model: options.model,
          prompt: evalCase.prompt,
          provider: "codex",
          verbose: options.verbose,
        },
        { paths, reporter },
      );
      return { exitCode };
    } finally {
      fixtureValidation = finalizeFixtureValidationAfterAgent(
        paths,
        sourceRepoPath,
        initialFixtureValidation,
        rawAccessMonitors,
      );
    }
  })();
  const validatorResult = runPacketValidator(paths);
  appendEvent(paths.eventsPath, {
    args: validatorResult.args,
    caseId: evalCase.id,
    command: validatorResult.command,
    exitCode: validatorResult.exitCode,
    type: "packet_validator_finished",
  });
  const events = readEvents(paths.eventsPath);
  const metrics = deriveMetrics(events, evalCase, runnerResult.exitCode, validatorResult, paths);
  const passed = casePassed(fixtureValidation, metrics);
  const summary: CaseRunSummary = {
    caseId: evalCase.id,
    fixtureValidation,
    metrics,
    passed,
    prompt: evalCase.prompt,
    runRoot: paths.runRoot,
    startedAt,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMdPath: paths.summaryMdPath,
    workspacePath: paths.workspacePath,
  };
  writeCaseSummaries(summary);
  reporter.summaryWritten(paths.summaryJsonPath, paths.summaryMdPath);
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    passed,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMdPath: paths.summaryMdPath,
    type: "case_finished",
  });
  reporter.caseFinished(passed);
  return summary;
}
