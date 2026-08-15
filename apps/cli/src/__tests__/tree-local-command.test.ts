import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  createSdkFromResolvedRuntimeAgent: vi.fn(),
  resolveRuntimeLocalAgent: vi.fn(),
}));
const bindingMocks = vi.hoisted(() => ({
  readAgentContextTreeBinding: vi.fn(),
}));

vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../core/context-tree-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/context-tree-binding.js")>()),
  readAgentContextTreeBinding: bindingMocks.readAgentContextTreeBinding,
}));

import { treeLocalCommand } from "../commands/tree/local.js";
import { verifyTreeRoot } from "../commands/tree/verify.js";

const originalCwd = process.cwd();
const roots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("tree local resolve command", () => {
  it("runs the actual guard/scaffold path and performs both authoritative binding reads", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "ft-tree-local-command-")));
    roots.push(workspaceRoot);
    const agentId = "agent-command-uuid";
    const agentName = "command-agent";
    const serverUrl = "https://first-tree.example";
    const runtimeSessionToken = "runtime-proof";
    const localRoot = join(workspaceRoot, "local-context");
    mkdirSync(join(workspaceRoot, ".first-tree-workspace"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".first-tree-workspace", "identity.json"),
      JSON.stringify({ agentId, agentName, contextSourceKind: "local", contextTreePath: localRoot, serverUrl }),
    );
    process.chdir(workspaceRoot);
    const sdk = { agentId };
    const agentSnapshot = { agentId, agentName, runtimeSessionToken, serverUrl, workspaceRoot };
    localAgentMocks.resolveRuntimeLocalAgent.mockReturnValue(agentSnapshot);
    localAgentMocks.createSdk.mockImplementation(() => {
      throw new Error("unexpected local Agent config reread");
    });
    localAgentMocks.createSdkFromResolvedRuntimeAgent.mockReturnValue(sdk);
    bindingMocks.readAgentContextTreeBinding.mockResolvedValue({ status: "unbound", repo: null, branch: "main" });
    let output = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    const program = new Command();
    const local = program.command("local");
    treeLocalCommand.configure?.(local);
    await program.parseAsync(["node", "first-tree", "local", "resolve", "--ensure", "--intent", "read"]);

    expect(localAgentMocks.resolveRuntimeLocalAgent).toHaveBeenCalledTimes(1);
    expect(localAgentMocks.createSdkFromResolvedRuntimeAgent).toHaveBeenCalledWith(agentSnapshot);
    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
    expect(bindingMocks.readAgentContextTreeBinding).toHaveBeenCalledTimes(2);
    expect(bindingMocks.readAgentContextTreeBinding).toHaveBeenCalledWith(sdk, { agent: agentName });
    expect(verifyTreeRoot(localRoot).ok).toBe(true);
    expect(output).toContain(`Local Context: ${realpathSync(localRoot)}`);
    expect(output).toContain(`Agent: ${agentName} (${agentId})`);
    expect(output).toContain("State: verified");
  });

  it("rejects a Workspace reached through a symlinked ancestor before scaffold mutation", async () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "ft-tree-local-command-parent-")));
    roots.push(fixtureRoot);
    const realParent = join(fixtureRoot, "real-parent");
    const aliasParent = join(fixtureRoot, "alias-parent");
    const realWorkspace = join(realParent, "workspace");
    const aliasWorkspace = join(aliasParent, "workspace");
    const agentId = "agent-command-symlink";
    const agentName = "command-agent";
    const serverUrl = "https://first-tree.example";
    const runtimeSessionToken = "runtime-proof";
    mkdirSync(join(realWorkspace, ".first-tree-workspace"), { recursive: true });
    symlinkSync(realParent, aliasParent);
    const identityPath = join(realWorkspace, ".first-tree-workspace", "identity.json");
    const identityBytes = JSON.stringify({
      agentId,
      agentName,
      contextSourceKind: "local",
      contextTreePath: join(aliasWorkspace, "local-context"),
      serverUrl,
    });
    writeFileSync(identityPath, identityBytes);
    localAgentMocks.resolveRuntimeLocalAgent.mockReturnValue({
      agentId,
      agentName,
      runtimeSessionToken,
      serverUrl,
      workspaceRoot: aliasWorkspace,
    });
    localAgentMocks.createSdkFromResolvedRuntimeAgent.mockReturnValue({ agentId });
    process.chdir(realWorkspace);
    let output = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);

    const program = new Command();
    const local = program.command("local");
    treeLocalCommand.configure?.(local);
    await expect(
      program.parseAsync(["node", "first-tree", "local", "resolve", "--ensure", "--intent", "read"]),
    ).rejects.toThrow("exit:1");

    expect(bindingMocks.readAgentContextTreeBinding).not.toHaveBeenCalled();
    expect(output).toContain("must not traverse a symlinked or aliased ancestor");
    expect(readFileSync(identityPath, "utf8")).toBe(identityBytes);
    expect(existsSync(join(realWorkspace, "local-context"))).toBe(false);
  });
});
