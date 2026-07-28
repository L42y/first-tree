import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { RETURN_MEETING_CONTEXT_GATE_CASES } from "../cases.js";
import { setupFixture, validateFixture } from "../fixture.js";

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

describe("return-meeting-context fixture", () => {
  it("gives the natural routing case a real choice between meeting and write skills", () => {
    const evalCase = RETURN_MEETING_CONTEXT_GATE_CASES.find(
      (candidate) => candidate.fixture.routing === "meeting-vs-write",
    );
    if (evalCase === undefined) throw new Error("missing composed routing case");
    const paths = createRunPaths({
      caseId: "return-meeting-context-composed-fixture-test",
      packageRoot: packageRoot(),
      startedAt: "2026-07-28T00:00:00.000Z",
    });

    try {
      const sourceRepoPath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      expect(validateFixture(evalCase, paths, sourceRepoPath)).toEqual({
        errors: [],
        ok: true,
        requiredFilesOk: true,
      });
      expect(existsSync(join(paths.workspacePath, ".agents", "skills", "return-meeting-context", "SKILL.md"))).toBe(
        true,
      );
      expect(existsSync(join(paths.workspacePath, ".agents", "skills", "first-tree-write", "SKILL.md"))).toBe(true);
      expect(existsSync(join(paths.workspacePath, "context-tree"))).toBe(false);

      const agentsMarkdown = readFileSync(join(paths.workspacePath, "AGENTS.md"), "utf8");
      expect(agentsMarkdown).toContain("`return-meeting-context`");
      expect(agentsMarkdown).toContain("`first-tree-write`");
      expect(agentsMarkdown).toContain("meeting artifacts always enter `return-meeting-context` first");
      expect(agentsMarkdown).not.toContain("Read `.agents/skills/return-meeting-context/SKILL.md` before acting");
      expect(agentsMarkdown).not.toContain("invoke first-tree-write");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
