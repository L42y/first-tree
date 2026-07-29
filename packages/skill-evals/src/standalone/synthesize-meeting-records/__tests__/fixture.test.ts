import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readEvents } from "../../../core/events.js";
import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { SYNTHESIZE_MEETING_RECORDS_CASES } from "../cases.js";
import {
  setupFixture,
  startPartialRawAccessMonitors,
  stopPartialRawAccessMonitors,
  validateFixture,
} from "../fixture.js";

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
      expect(existsSync(join(paths.workspacePath, "context-tree"))).toBe(false);
      expect(readFileSync(join(paths.workspacePath, "AGENTS.md"), "utf8")).toContain("`synthesize-meeting-records`");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("makes partial-source raw artifacts unavailable before semantic analysis", () => {
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
      const monitors = startPartialRawAccessMonitors(paths, sourceRepoPath);
      try {
        expect(readFileSync(join(sourceRepoPath, "appendix.md"), "utf8")).toBe("");
      } finally {
        stopPartialRawAccessMonitors(monitors);
      }
      expect(readEvents(paths.eventsPath)).toContainEqual(
        expect.objectContaining({
          locator: "source-artifacts/appendix.md",
          type: "partial_raw_access_attempt",
        }),
      );
      rmSync(join(sourceRepoPath, "appendix.md"));
      writeFileSync(join(sourceRepoPath, "appendix.md"), "raw content must remain unavailable\n", "utf8");
      expect(validateFixture(paths, sourceRepoPath).errors).toContain(
        "partial-source fixture exposed non-sentinel raw artifact: source-artifacts/appendix.md",
      );
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
