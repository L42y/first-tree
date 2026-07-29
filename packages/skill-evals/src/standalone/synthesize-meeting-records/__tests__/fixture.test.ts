import { once } from "node:events";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
import { rawArtifactReadObserved } from "../grader.js";

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
      expect(validateFixture(paths, sourceRepoPath).errors).toContain(
        "partial-source fixture exposed non-sentinel raw artifact: source-artifacts/appendix.md",
      );
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
      expect(validateFixture(paths, sourceRepoPath).errors).toContain(
        "partial-source fixture missing raw access sentinel: source-artifacts/appendix.md",
      );
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
