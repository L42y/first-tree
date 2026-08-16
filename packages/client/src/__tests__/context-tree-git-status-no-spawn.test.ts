import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync,
}));

import { createContextTreeGitWriteTracker } from "../runtime/context-tree-git-status.js";

describe("createContextTreeGitWriteTracker git spawn gate", () => {
  let root: string;
  let tree: string;

  beforeEach(() => {
    execFileSync.mockReset();
    execFileSync.mockImplementation(() => {
      throw new Error("git must not spawn in this test");
    });
    root = mkdtempSync(join(tmpdir(), "first-tree-git-status-no-spawn-"));
    tree = join(root, "tree");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "NODE.md"), "local\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("never spawns git for a Local path that has no remote repo URL", () => {
    const tracker = createContextTreeGitWriteTracker({
      contextTreePath: tree,
      contextTreeRepoUrl: null,
      contextTreeBranch: null,
    });
    writeFileSync(join(tree, "NODE.md"), "updated without attribution\n");
    expect(
      tracker.refsForSuccessfulToolCall({
        toolName: "Bash",
        toolUseId: "tu-local-path",
        existingRefs: [],
      }),
    ).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("never spawns git when a path is present but repo URL is empty", () => {
    const tracker = createContextTreeGitWriteTracker({
      contextTreePath: tree,
      contextTreeRepoUrl: "",
      contextTreeBranch: "main",
    });
    tracker.captureBaseline();
    expect(
      tracker.refsForSuccessfulToolCall({
        toolName: "Bash",
        toolUseId: "tu-empty-url",
        existingRefs: [],
      }),
    ).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
