import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCommand } from "../../../core/commands.js";
import { isRecord, readEvents } from "../../../core/events.js";
import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { SYNTHESIZE_MEETING_RECORDS_CASES } from "../cases.js";
import {
  setupFixture,
  startPartialRawAccessMonitors,
  stopPartialRawAccessMonitors,
  validateFixture,
  validatePartialRawAccessMonitors,
} from "../fixture.js";
import { rawArtifactReadObserved, sourceRepoChanged } from "../grader.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("standalone synthesize-meeting-records fixture", () => {
  it("installs the experimental skill without creating a Client or Tree binding", () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES[0];
    if (evalCase === undefined) throw new Error("Missing eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-fixture-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:00.000Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      expect(validateFixture(paths, sourceRepoPath)).toMatchObject({ ok: true, requiredFilesOk: true });
      expect(existsSync(join(paths.workspacePath, ".agents", "skills", "synthesize-meeting-records", "SKILL.md"))).toBe(
        true,
      );
      expect(existsSync(join(paths.workspacePath, ".claude", "skills", "synthesize-meeting-records"))).toBe(false);
      expect(existsSync(join(paths.workspacePath, "context-tree"))).toBe(false);
      expect(readFileSync(join(paths.workspacePath, "AGENTS.md"), "utf8")).toContain("`synthesize-meeting-records`");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("allows only the packet write and rejects modified installed instructions", () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES[0];
    if (evalCase === undefined) throw new Error("Missing eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-instruction-integrity-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:00.500Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      writeFileSync(join(paths.workspacePath, "meeting-analysis-output.json"), "{}\n", "utf8");
      writeFileSync(paths.modelEventsPath, '{"type":"model-diagnostic"}\n', "utf8");
      expect(validateFixture(paths, sourceRepoPath).ok).toBe(true);

      const agentsPath = join(paths.workspacePath, "AGENTS.md");
      writeFileSync(agentsPath, `${readFileSync(agentsPath, "utf8")}\nmodel change\n`, "utf8");
      writeFileSync(join(paths.workspacePath, "undeclared-output.txt"), "unexpected\n", "utf8");
      const validation = validateFixture(paths, sourceRepoPath);

      expect(validation.ok).toBe(false);
      expect(validation.errors).toEqual(["workspace fixture content changed after setup"]);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("rejects undeclared retained files inside every allowed workspace container", () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES[0];
    if (evalCase === undefined) throw new Error("Missing eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-nested-write-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:00.625Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      const retainedCopies = [
        join(paths.workspacePath, ".agents", "undeclared-private-copy.md"),
        join(paths.workspacePath, ".first-tree-eval", "undeclared-private-copy.md"),
        join(sourceRepoPath, ".git", "model-output", "undeclared-private-copy.md"),
      ];
      for (const path of retainedCopies) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "VERBATIM-CANARY-RETAINED-PRIVATE-COPY\n", "utf8");
      }

      const validation = validateFixture(paths, sourceRepoPath);
      expect(validation.ok).toBe(false);
      expect(validation.errors).toContain("workspace fixture content changed after setup");
      expect(sourceRepoChanged(readEvents(paths.eventsPath), paths)).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("rejects a replaced .agents ancestor before scanning the redirected installed Skill", () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES[0];
    if (evalCase === undefined) throw new Error("Missing eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-agents-ancestor-replacement-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:00.675Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      const outsideAgentsPath = join(paths.runRoot, "outside-agents");
      const outsideSkillPath = join(outsideAgentsPath, "skills", "synthesize-meeting-records");
      const outsideCanaryPath = join(outsideSkillPath, "outside-canary.txt");
      mkdirSync(outsideSkillPath, { recursive: true });
      writeFileSync(outsideCanaryPath, "", "utf8");
      truncateSync(outsideCanaryPath, 21 * 1024 * 1024);
      chmodSync(outsideCanaryPath, 0o000);

      const installedAgentsPath = join(paths.workspacePath, ".agents");
      rmSync(installedAgentsPath, { force: true, recursive: true });
      symlinkSync(outsideAgentsPath, installedAgentsPath);

      const validation = validateFixture(paths, sourceRepoPath);
      expect(validation).toMatchObject({
        errors: ["workspace fixture content changed after setup"],
        ok: false,
        requiredFilesOk: false,
      });
      expect(validation.errors.join("\n")).not.toContain("outside-canary");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("rejects symlinked packet and model event receipt paths", () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES[0];
    if (evalCase === undefined) throw new Error("Missing eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-mutable-path-identity-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:00.700Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      symlinkSync("AGENTS.md", join(paths.workspacePath, "meeting-analysis-output.json"));
      rmSync(paths.modelEventsPath);
      symlinkSync("../AGENTS.md", paths.modelEventsPath);

      const validation = validateFixture(paths, sourceRepoPath);
      expect(validation.ok).toBe(false);
      expect(validation.errors).toEqual(["workspace fixture content changed after setup"]);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("detects source content hidden behind assume-unchanged Git metadata", () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "six-categories");
    if (evalCase === undefined) throw new Error("Missing six-categories eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-source-manifest-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:00.750Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      expect(runCommand("git", ["update-index", "--assume-unchanged", "minutes.md"], sourceRepoPath).exitCode).toBe(0);
      writeFileSync(join(sourceRepoPath, "minutes.md"), "hidden source mutation\n", "utf8");
      expect(runCommand("git", ["status", "--porcelain"], sourceRepoPath).stdout.trim()).toBe("");

      const validation = validateFixture(paths, sourceRepoPath);
      expect(validation.errors).toEqual(["workspace fixture content changed after setup"]);
      expect(sourceRepoChanged(readEvents(paths.eventsPath), paths)).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("makes partial-source raw artifacts unavailable before semantic analysis", async () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "partial-source");
    if (evalCase === undefined) throw new Error("Missing partial-source eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-partial-fixture-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:01.000Z",
    });
    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      const bundle = JSON.parse(readFileSync(join(sourceRepoPath, "bundle.json"), "utf8")) as {
        artifacts: Array<{ completeness: string }>;
      };
      expect(bundle.artifacts.some((artifact) => artifact.completeness === "partial")).toBe(true);
      expect(lstatSync(join(sourceRepoPath, "minutes.md")).isFIFO()).toBe(true);
      expect(lstatSync(join(sourceRepoPath, "appendix.md")).isFIFO()).toBe(true);
      expect(validateFixture(paths, sourceRepoPath).ok).toBe(true);
      const monitors = await startPartialRawAccessMonitors(paths, sourceRepoPath);
      try {
        expect(readFileSync(join(sourceRepoPath, "appendix.md"), "utf8")).toBe("");
        expect(readEvents(paths.eventsPath)).toContainEqual(
          expect.objectContaining({
            locator: "source-artifacts/appendix.md",
            type: "partial_raw_access_attempt",
          }),
        );
        expect(validatePartialRawAccessMonitors(paths, monitors)).toEqual([]);
      } finally {
        stopPartialRawAccessMonitors(monitors);
      }
      rmSync(join(sourceRepoPath, "appendix.md"));
      writeFileSync(join(sourceRepoPath, "appendix.md"), "raw content must remain unavailable\n", "utf8");
      expect(validateFixture(paths, sourceRepoPath).errors).toEqual(["workspace fixture content changed after setup"]);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("detects a removed or replaced sentinel and an unhealthy monitor after the agent run", async () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "partial-source");
    if (evalCase === undefined) throw new Error("Missing partial-source eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-sentinel-integrity-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:02.000Z",
    });
    const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
    const monitors = await startPartialRawAccessMonitors(paths, sourceRepoPath);
    try {
      rmSync(join(sourceRepoPath, "appendix.md"));
      expect(validateFixture(paths, sourceRepoPath).errors).toEqual(["workspace fixture content changed after setup"]);
      writeFileSync(join(sourceRepoPath, "appendix.md"), "", "utf8");
      expect(validatePartialRawAccessMonitors(paths, monitors)).toContain(
        "post-run raw access sentinel identity changed: source-artifacts/appendix.md",
      );
      const appendixMonitor = monitors.find((monitor) => monitor.locator === "source-artifacts/appendix.md");
      if (appendixMonitor === undefined) throw new Error("Missing appendix raw access monitor.");
      const monitorExited = once(appendixMonitor.child, "exit");
      appendixMonitor.child.kill("SIGTERM");
      await monitorExited;
      expect(validatePartialRawAccessMonitors(paths, monitors)).toContain(
        "raw access monitor stopped before teardown: source-artifacts/appendix.md",
      );
    } finally {
      stopPartialRawAccessMonitors(monitors);
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("records a sentinel move-away and move-back even when the protected path read fails", async () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "partial-source");
    if (evalCase === undefined) throw new Error("Missing partial-source eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-sentinel-continuity-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:04.000Z",
    });
    const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
    const monitors = await startPartialRawAccessMonitors(paths, sourceRepoPath);
    try {
      const sentinelPath = join(sourceRepoPath, "appendix.md");
      const movedPath = join(sourceRepoPath, ".appendix.md.moved");
      renameSync(sentinelPath, movedPath);
      try {
        expect(() => readFileSync(sentinelPath, "utf8")).toThrow();
      } finally {
        renameSync(movedPath, sentinelPath);
      }

      await expect
        .poll(
          () =>
            readEvents(paths.eventsPath).some(
              (event) =>
                isRecord(event) &&
                event.type === "partial_raw_path_mutation" &&
                event.locator === "source-artifacts/appendix.md",
            ),
          { timeout: 1_000 },
        )
        .toBe(true);
      expect(validatePartialRawAccessMonitors(paths, monitors)).toEqual([]);
      expect(rawArtifactReadObserved(readEvents(paths.eventsPath), evalCase)).toBe(true);
    } finally {
      stopPartialRawAccessMonitors(monitors);
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("records a sentinel permission change before a failed read and restored mode", async () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "partial-source");
    if (evalCase === undefined) throw new Error("Missing partial-source eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-sentinel-permission-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:04.500Z",
    });
    const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
    const monitors = await startPartialRawAccessMonitors(paths, sourceRepoPath);
    try {
      const sentinelPath = join(sourceRepoPath, "appendix.md");
      const originalMode = lstatSync(sentinelPath).mode & 0o777;
      chmodSync(sentinelPath, 0);
      try {
        expect(() => readFileSync(sentinelPath, "utf8")).toThrow();
      } finally {
        chmodSync(sentinelPath, originalMode);
      }

      await expect
        .poll(
          () =>
            readEvents(paths.eventsPath).some(
              (event) =>
                isRecord(event) &&
                event.type === "partial_raw_path_mutation" &&
                event.locator === "source-artifacts/appendix.md",
            ),
          { timeout: 1_000 },
        )
        .toBe(true);
      expect(validatePartialRawAccessMonitors(paths, monitors)).toEqual([]);
      expect(rawArtifactReadObserved(readEvents(paths.eventsPath), evalCase)).toBe(true);
    } finally {
      stopPartialRawAccessMonitors(monitors);
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("records a source directory move-away and move-back before a failed protected path read", async () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "partial-source");
    if (evalCase === undefined) throw new Error("Missing partial-source eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-source-directory-continuity-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:05.000Z",
    });
    const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
    const monitors = await startPartialRawAccessMonitors(paths, sourceRepoPath);
    try {
      const movedSourceRepoPath = join(paths.workspacePath, "source-artifacts.moved");
      renameSync(sourceRepoPath, movedSourceRepoPath);
      try {
        expect(() => readFileSync(join(sourceRepoPath, "appendix.md"), "utf8")).toThrow();
      } finally {
        renameSync(movedSourceRepoPath, sourceRepoPath);
      }

      await expect
        .poll(
          () =>
            readEvents(paths.eventsPath).some(
              (event) =>
                isRecord(event) &&
                event.type === "partial_raw_path_mutation" &&
                event.locator === "source-artifacts/appendix.md",
            ),
          { timeout: 1_000 },
        )
        .toBe(true);
      expect(validatePartialRawAccessMonitors(paths, monitors)).toEqual([]);
      expect(rawArtifactReadObserved(readEvents(paths.eventsPath), evalCase)).toBe(true);
    } finally {
      stopPartialRawAccessMonitors(monitors);
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("records a workspace move-away and move-back across the full protected pathname", async () => {
    const evalCase = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === "partial-source");
    if (evalCase === undefined) throw new Error("Missing partial-source eval case.");
    const paths = createRunPaths({
      caseId: "standalone-meeting-workspace-continuity-test",
      packageRoot,
      startedAt: "2026-07-29T00:00:06.000Z",
    });
    const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
    const monitors = await startPartialRawAccessMonitors(paths, sourceRepoPath);
    try {
      const movedWorkspacePath = join(paths.runRoot, "workspace.moved");
      renameSync(paths.workspacePath, movedWorkspacePath);
      try {
        expect(() => readFileSync(join(sourceRepoPath, "appendix.md"), "utf8")).toThrow();
      } finally {
        renameSync(movedWorkspacePath, paths.workspacePath);
      }

      await expect
        .poll(
          () =>
            readEvents(paths.eventsPath).some(
              (event) =>
                isRecord(event) &&
                event.type === "partial_raw_path_mutation" &&
                event.locator === "source-artifacts/appendix.md",
            ),
          { timeout: 1_000 },
        )
        .toBe(true);
      expect(validatePartialRawAccessMonitors(paths, monitors)).toEqual([]);
      expect(rawArtifactReadObserved(readEvents(paths.eventsPath), evalCase)).toBe(true);
    } finally {
      stopPartialRawAccessMonitors(monitors);
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
