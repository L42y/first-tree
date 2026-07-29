import { once } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { SYNTHESIZE_MEETING_RECORDS_CASES } from "../cases.js";
import { setupFixture, startPartialRawAccessMonitors, validateFixture } from "../fixture.js";
import { finalizeFixtureValidationAfterAgent } from "../runner.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("standalone synthesize-meeting-records runner cleanup", () => {
  it.each([
    {
      changeBundle: (bundlePath: string) => rmSync(bundlePath),
      description: "removes",
      expectedError: "bundle.json",
    },
    {
      changeBundle: (bundlePath: string) => writeFileSync(bundlePath, "{not-json", "utf8"),
      description: "corrupts",
      expectedError: "invalid meeting artifact bundle",
    },
  ])("fails cleanly and stops every monitor when the agent $description bundle.json", async ({
    changeBundle,
    expectedError,
  }) => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "partial-source");
    if (evalCase === undefined) throw new Error("Missing partial-source eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-runner-cleanup-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:03.000Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      const initialValidation = validateFixture(paths, sourceRepoPath);
      const monitors = await startPartialRawAccessMonitors(paths, sourceRepoPath);
      const monitorExits = monitors.map((monitor) =>
        monitor.child.exitCode === null ? once(monitor.child, "exit") : Promise.resolve([]),
      );

      changeBundle(join(sourceRepoPath, "bundle.json"));
      const finalValidation = finalizeFixtureValidationAfterAgent(paths, sourceRepoPath, initialValidation, monitors);

      expect(finalValidation.ok).toBe(false);
      expect(finalValidation.errors.some((error) => error.includes(expectedError))).toBe(true);
      expect(monitors.every((monitor) => monitor.child.killed)).toBe(true);
      await Promise.all(monitorExits);
      expect(monitors.every((monitor) => monitor.child.exitCode !== null || monitor.child.signalCode !== null)).toBe(
        true,
      );
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
