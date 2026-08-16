import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localAgentMemberNodeContent,
  localContextRootNodeContent,
  localMembersIndexContent,
} from "../commands/tree/scaffold-templates.js";
import { readContextTreeSnapshot, runTreeTreeCommand } from "../commands/tree/tree.js";
import { verifyTreeRoot } from "../commands/tree/verify.js";
import { resolveLocalContext } from "../core/local-context/index.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runChildScenario(workspace: string): Promise<void> {
  const agentName = "no-git-agent";
  const agentId = "agent-no-git";
  const serverUrl = "https://first-tree.example";
  const localRoot = join(workspace, "local-context");
  mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
  writeFileSync(
    join(workspace, ".first-tree-workspace", "identity.json"),
    JSON.stringify({ agentId, agentName, contextSourceKind: "local", contextTreePath: localRoot, serverUrl }),
  );
  const input = {
    agentId,
    agentName,
    cwd: workspace,
    ensure: true,
    intent: "read" as const,
    scaffold: {
      memberNode: localAgentMemberNodeContent(agentName),
      membersIndex: localMembersIndexContent(agentName),
      rootNode: localContextRootNodeContent(agentName),
    },
    serverUrl,
    workspaceRoot: workspace,
  };
  const deps = {
    readBinding: async () => ({ status: "unbound" as const }),
    recordRemoteBinding: async () => undefined,
    verifyTree: verifyTreeRoot,
  };
  const read = await resolveLocalContext(input, deps);
  expect(read.verified).toBe(true);

  let commandOutput = "";
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    commandOutput += String(chunk);
    return true;
  });
  runTreeTreeCommand({
    options: { json: false, debug: false, quiet: false },
    command: { args: [], opts: () => ({ treePath: read.path }) } as never,
  });
  stderr.mockRestore();
  expect(commandOutput).toContain("Mode: filesystem");
  expect(commandOutput).not.toMatch(/pull|branch|git fallback/iu);

  writeFileSync(
    join(read.path, "decision.md"),
    [
      "---",
      'title: "Local Decision"',
      `owners: [${agentName}]`,
      "---",
      "",
      "# Local Decision",
      "",
      "## Decision",
      "",
      "Keep this durable local constraint.",
      "",
    ].join("\n"),
  );
  expect(verifyTreeRoot(read.path).ok).toBe(true);
  const write = await resolveLocalContext({ ...input, intent: "write" }, deps);
  expect(write).toMatchObject({ verified: true, repairOnly: false });
  expect(JSON.stringify(readContextTreeSnapshot(write.path))).toContain("Local Decision");
}

describe("Local Context without Git", () => {
  it("runs guard, real filesystem command, verify, and direct write in a Git-free child process", async () => {
    const workspace = process.env.FIRST_TREE_LOCAL_CONTEXT_CHILD_WORKSPACE;
    if (process.env.FIRST_TREE_LOCAL_CONTEXT_CHILD === "1") {
      expect(workspace).toBeTruthy();
      expect(process.env.PATH).toBe(join(workspace as string, "empty-bin"));
      await runChildScenario(workspace as string);
      return;
    }

    const childWorkspace = mkdtempSync(join(realpathSync(tmpdir()), "ft-local-no-git-"));
    const emptyPath = join(childWorkspace, "empty-bin");
    mkdirSync(emptyPath);
    roots.push(childWorkspace);
    const vitest = require.resolve("vitest/vitest.mjs");
    const result = spawnSync(
      process.execPath,
      [vitest, "run", "src/__tests__/local-context-no-git-subprocess.test.ts", "--maxWorkers=1", "--minWorkers=1"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_LOCAL_CONTEXT_CHILD: "1",
          FIRST_TREE_LOCAL_CONTEXT_CHILD_WORKSPACE: childWorkspace,
          PATH: emptyPath,
        },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
