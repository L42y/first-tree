import { once } from "node:events";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { SYNTHESIZE_MEETING_RECORDS_CASES } from "../cases.js";
import { setupFixture, startPartialRawAccessMonitors, validateFixture } from "../fixture.js";
import { casePassed, deriveMetrics } from "../grader.js";
import { finalizeFixtureValidationAfterAgent, runPacketValidator } from "../runner.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("standalone synthesize-meeting-records runner cleanup", () => {
  it("rejects a modified installed validator without executing model-controlled code", () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "six-categories");
    if (evalCase === undefined) throw new Error("Missing six-categories eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-validator-integrity-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:02.500Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      const initialValidation = validateFixture(paths, sourceRepoPath);
      const markerPath = join(paths.workspacePath, "model-validator-ran");
      const installedValidatorPath = join(
        paths.workspacePath,
        ".agents",
        "skills",
        "synthesize-meeting-records",
        "scripts",
        "validate-output.mjs",
      );
      writeFileSync(
        installedValidatorPath,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "unsafe\\n");\n`,
        "utf8",
      );
      writeFileSync(join(paths.workspacePath, "meeting-analysis-output.json"), "{}\n", "utf8");

      const finalValidation = finalizeFixtureValidationAfterAgent(paths, sourceRepoPath, initialValidation, []);
      const validatorResult = runPacketValidator(paths, finalValidation);

      expect(validatorResult.exitCode).not.toBe(0);
      expect(validatorResult.command).toBe("packet-validator-skipped");
      expect(existsSync(markerPath)).toBe(false);
      expect(finalValidation.ok).toBe(false);
      expect(finalValidation.errors).toContain("post-run workspace fixture content changed after setup");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("passes only host snapshots of regular bundle and packet files to the canonical validator", () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "six-categories");
    if (evalCase === undefined) throw new Error("Missing six-categories eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-validator-snapshot-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:02.750Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      const initialValidation = validateFixture(paths, sourceRepoPath);
      writeFileSync(join(paths.workspacePath, "meeting-analysis-output.json"), "{}\n", "utf8");
      const finalValidation = finalizeFixtureValidationAfterAgent(paths, sourceRepoPath, initialValidation, []);
      const validatorResult = runPacketValidator(paths, finalValidation);

      expect(finalValidation.ok).toBe(true);
      expect(validatorResult.command).toBe("node");
      expect(validatorResult.args).toContain(join(paths.runRoot, "validator-inputs", "bundle.json"));
      expect(validatorResult.args).toContain(join(paths.runRoot, "validator-inputs", "meeting-analysis-output.json"));
      expect(validatorResult.args).not.toContain(join(paths.workspacePath, "source-artifacts", "bundle.json"));
      expect(validatorResult.args).not.toContain(join(paths.workspacePath, "meeting-analysis-output.json"));
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it.each(["bundle", "packet"] as const)("skips host validation before opening a symlinked %s path", (target) => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "six-categories");
    if (evalCase === undefined) throw new Error("Missing six-categories eval case.");
    const paths = createRunPaths({
      caseId: `standalone-meeting-${target}-symlink-guard-test`,
      packageRoot,
      startedAt: `2026-07-29T00:00:02.${target === "bundle" ? "800" : "850"}Z`,
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      const initialValidation = validateFixture(paths, sourceRepoPath);
      const outsidePath = join(paths.runRoot, `outside-${target}.json`);
      writeFileSync(outsidePath, "{}\n", "utf8");
      const targetPath =
        target === "bundle"
          ? join(sourceRepoPath, "bundle.json")
          : join(paths.workspacePath, "meeting-analysis-output.json");
      rmSync(targetPath, { force: true });
      symlinkSync(outsidePath, targetPath);

      const finalValidation = finalizeFixtureValidationAfterAgent(paths, sourceRepoPath, initialValidation, []);
      const validatorResult = runPacketValidator(paths, finalValidation);

      expect(finalValidation.ok).toBe(false);
      expect(validatorResult.command).toBe("packet-validator-skipped");
      expect(existsSync(join(paths.runRoot, "validator-inputs"))).toBe(false);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it.each([
    {
      changeBundle: (bundlePath: string) => rmSync(bundlePath),
      description: "removes",
    },
    {
      changeBundle: (bundlePath: string) => writeFileSync(bundlePath, "{not-json", "utf8"),
      description: "corrupts",
    },
  ])("fails cleanly and stops every monitor when the agent $description bundle.json", async ({ changeBundle }) => {
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
      expect(finalValidation.errors).toContain("post-run workspace fixture content changed after setup");
      expect(monitors.every((monitor) => monitor.child.killed)).toBe(true);
      await Promise.all(monitorExits);
      expect(monitors.every((monitor) => monitor.child.exitCode !== null || monitor.child.signalCode !== null)).toBe(
        true,
      );
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("does not resolve raw sentinel paths after the workspace integrity guard fails", async () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "partial-source");
    if (evalCase === undefined) throw new Error("Missing partial-source eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-finalizer-source-ancestor-guard-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:03.250Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      const initialValidation = validateFixture(paths, sourceRepoPath);
      const monitors = await startPartialRawAccessMonitors(paths, sourceRepoPath);
      const monitorExits = monitors.map((monitor) =>
        monitor.child.exitCode === null ? once(monitor.child, "exit") : Promise.resolve([]),
      );
      const retainedSourceRepoPath = join(paths.runRoot, "retained-source-artifacts");
      const outsideSourceRepoPath = join(paths.runRoot, "outside-source-artifacts");
      mkdirSync(outsideSourceRepoPath);
      writeFileSync(join(outsideSourceRepoPath, "minutes.md"), "outside canary\n", "utf8");
      writeFileSync(join(outsideSourceRepoPath, "appendix.md"), "outside canary\n", "utf8");
      renameSync(sourceRepoPath, retainedSourceRepoPath);
      symlinkSync(outsideSourceRepoPath, sourceRepoPath);

      const finalValidation = finalizeFixtureValidationAfterAgent(paths, sourceRepoPath, initialValidation, monitors);

      expect(finalValidation.ok).toBe(false);
      expect(finalValidation.errors).toEqual(["post-run workspace fixture content changed after setup"]);
      expect(finalValidation.errors.some((error) => error.includes("raw access sentinel identity changed"))).toBe(
        false,
      );
      expect(monitors.every((monitor) => monitor.child.killed)).toBe(true);
      await Promise.all(monitorExits);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("counts an existing or dangling context-tree symlink as a side effect without following its target", () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "six-categories");
    if (evalCase === undefined) throw new Error("Missing six-categories eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-context-tree-symlink-metric-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:03.500Z",
    });
    try {
      const failedFixtureValidation = {
        errors: ["post-run workspace fixture content changed after setup"],
        ok: false,
        requiredFilesOk: false,
      };
      const outsideContextTreePath = join(paths.runRoot, "outside-context-tree");
      mkdirSync(outsideContextTreePath);
      symlinkSync(outsideContextTreePath, join(paths.workspacePath, "context-tree"));
      const validatorResult = runPacketValidator(paths, failedFixtureValidation);

      const linkedMetrics = deriveMetrics([], evalCase, failedFixtureValidation, 0, validatorResult, paths);
      rmSync(outsideContextTreePath, { recursive: true });
      const danglingMetrics = deriveMetrics([], evalCase, failedFixtureValidation, 0, validatorResult, paths);

      expect(linkedMetrics.contextTreeCreated).toBe(true);
      expect(danglingMetrics.contextTreeCreated).toBe(true);
      expect(linkedMetrics.packetExists).toBe(false);
      expect(danglingMetrics.packetExists).toBe(false);
      expect(linkedMetrics.sourceRepoChanged).toBe(true);
      expect(danglingMetrics.sourceRepoChanged).toBe(true);
      expect(casePassed(failedFixtureValidation, linkedMetrics)).toBe(false);
      expect(casePassed(failedFixtureValidation, danglingMetrics)).toBe(false);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
