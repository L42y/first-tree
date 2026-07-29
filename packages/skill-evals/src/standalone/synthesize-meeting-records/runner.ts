import { join } from "node:path";

import { runCommand } from "../../core/commands.js";
import { appendEvent, readEvents } from "../../core/events.js";
import { createRunPaths } from "../../core/paths.js";
import { runAgentProvider } from "../../core/provider/index.js";
import { createEvalReporter } from "../../core/reporter.js";
import {
  setupFixture,
  startPartialRawAccessMonitors,
  stopPartialRawAccessMonitors,
  validateFixture,
  validatePartialRawAccessMonitors,
} from "./fixture.js";
import { casePassed, deriveMetrics } from "./grader.js";
import { writeCaseSummaries } from "./summary.js";
import type { CaseRunSummary, CliOptions, MeetingRecordsEvalCase } from "./types.js";

function runPacketValidator(workspacePath: string) {
  return runCommand(
    "node",
    [
      join(".agents", "skills", "synthesize-meeting-records", "scripts", "validate-output.mjs"),
      "--bundle",
      join("source-artifacts", "bundle.json"),
      "--output",
      "meeting-analysis-output.json",
    ],
    workspacePath,
  );
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
  const rawAccessMonitors = startPartialRawAccessMonitors(paths, sourceRepoPath);
  let postRunFixtureValidation = initialFixtureValidation;
  let rawAccessMonitorErrors: readonly string[] = [];
  const runnerResult = await (async () => {
    try {
      return await runAgentProvider(
        {
          caseId: evalCase.id,
          claudeBin: options.claudeBin,
          codexBin: options.codexBin,
          model: options.model,
          prompt: evalCase.prompt,
          provider: options.provider,
          verbose: options.verbose,
        },
        { paths, reporter },
      );
    } finally {
      postRunFixtureValidation = validateFixture(paths, sourceRepoPath);
      rawAccessMonitorErrors = validatePartialRawAccessMonitors(paths, rawAccessMonitors);
      stopPartialRawAccessMonitors(rawAccessMonitors);
    }
  })();
  const fixtureErrors = [
    ...initialFixtureValidation.errors,
    ...postRunFixtureValidation.errors.map((error) => `post-run ${error}`),
    ...rawAccessMonitorErrors,
  ];
  const fixtureValidation = {
    errors: fixtureErrors,
    ok: fixtureErrors.length === 0,
    requiredFilesOk: initialFixtureValidation.requiredFilesOk && postRunFixtureValidation.requiredFilesOk,
  };
  const validatorResult = runPacketValidator(paths.workspacePath);
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
