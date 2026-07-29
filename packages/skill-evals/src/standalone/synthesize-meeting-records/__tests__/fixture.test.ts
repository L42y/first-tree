import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { SYNTHESIZE_MEETING_RECORDS_CASES } from "../cases.js";
import { setupFixture, validateFixture } from "../fixture.js";

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
      expect(existsSync(join(sourceRepoPath, "minutes.md"))).toBe(false);
      expect(existsSync(join(sourceRepoPath, "appendix.md"))).toBe(false);
      expect(validateFixture(paths, sourceRepoPath).ok).toBe(true);
      writeFileSync(join(sourceRepoPath, "appendix.md"), "raw content must remain unavailable\n", "utf8");
      expect(validateFixture(paths, sourceRepoPath).errors).toContain(
        "partial-source fixture exposed raw artifact: source-artifacts/appendix.md",
      );
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
