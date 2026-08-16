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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localAgentMemberNodeContent,
  localContextRootNodeContent,
  localMembersIndexContent,
} from "../commands/tree/scaffold-templates.js";
import { verifyTreeRoot } from "../commands/tree/verify.js";
import { LocalContextError, type LocalContextScaffold, resolveLocalContext } from "../core/local-context/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  agentId: string;
  agentName: string;
  localRoot: string;
  scaffold: LocalContextScaffold;
  serverUrl: string;
  workspaceRoot: string;
} {
  const workspaceRoot = mkdtempSync(join(realpathSync(tmpdir()), "ft-local-context-"));
  roots.push(workspaceRoot);
  const agentName = "agent-local";
  const agentId = "agent-019ffad4";
  const serverUrl = "https://first-tree.example";
  const localRoot = join(workspaceRoot, "local-context");
  mkdirSync(join(workspaceRoot, ".first-tree-workspace"), { recursive: true });
  writeFileSync(
    join(workspaceRoot, ".first-tree-workspace", "identity.json"),
    JSON.stringify({ agentId, agentName, contextSourceKind: "local", contextTreePath: localRoot, serverUrl }),
  );
  return {
    agentId,
    agentName,
    localRoot,
    scaffold: {
      memberNode: localAgentMemberNodeContent(agentName),
      membersIndex: localMembersIndexContent(agentName),
      rootNode: localContextRootNodeContent(agentName),
    },
    serverUrl,
    workspaceRoot,
  };
}

function options(value: ReturnType<typeof fixture>, intent: "read" | "write" = "read") {
  return {
    agentId: value.agentId,
    agentName: value.agentName,
    cwd: value.workspaceRoot,
    ensure: true,
    intent,
    scaffold: value.scaffold,
    serverUrl: value.serverUrl,
    workspaceRoot: value.workspaceRoot,
  } as const;
}

describe("Local Context resolve guard", () => {
  it.each([
    "",
    ".",
    "..",
    ".hidden",
    "nested/member",
    "nested\\member",
  ])("rejects unsafe Agent member path segment %j before binding or filesystem mutation", async (agentName) => {
    const value = fixture();
    const readBinding = vi.fn(async () => ({ status: "unbound" as const }));

    await expect(
      resolveLocalContext(
        { ...options(value), agentName },
        { readBinding, recordRemoteBinding: vi.fn(), verifyTree: verifyTreeRoot },
      ),
    ).rejects.toMatchObject({ code: "LOCAL_CONTEXT_PATH_INVALID" });

    expect(readBinding).not.toHaveBeenCalled();
  });

  it("lazily creates and verifies the deterministic Agent-owned scaffold", async () => {
    const value = fixture();
    const result = await resolveLocalContext(options(value), {
      readBinding: async () => ({ status: "unbound" }),
      recordRemoteBinding: vi.fn(),
      verifyTree: verifyTreeRoot,
    });

    expect(result).toMatchObject({
      agentName: value.agentName,
      path: realpathSync(value.localRoot),
      repairOnly: false,
      verified: true,
    });
    expect(readFileSync(join(value.localRoot, "members", value.agentName, "NODE.md"), "utf8")).toContain("type: agent");
  });

  it("repairs missing scaffold files without overwriting existing business content", async () => {
    const value = fixture();
    mkdirSync(value.localRoot);
    writeFileSync(join(value.localRoot, "business.txt"), "keep me\n");

    await resolveLocalContext(options(value, "write"), {
      readBinding: async () => ({ status: "unbound" }),
      recordRemoteBinding: vi.fn(),
      verifyTree: verifyTreeRoot,
    });

    expect(readFileSync(join(value.localRoot, "business.txt"), "utf8")).toBe("keep me\n");
    expect(verifyTreeRoot(value.localRoot).ok).toBe(true);
  });

  it("read intent never repairs an existing Local root; write intent does", async () => {
    const value = fixture();
    // An interrupted or concurrent writer left an existing Local root whose
    // required scaffold entries are missing. Read resolve must fail closed
    // without recreating any of them (the atomic create/EEXIST ownership
    // means this call did not create the root, so no repair is allowed).
    mkdirSync(value.localRoot);

    await expect(
      resolveLocalContext(options(value), {
        readBinding: async () => ({ status: "unbound" }),
        recordRemoteBinding: vi.fn(),
        verifyTree: verifyTreeRoot,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CONTEXT_TREE_INVALID" });
    expect(existsSync(join(value.localRoot, "NODE.md"))).toBe(false);
    expect(existsSync(join(value.localRoot, "members"))).toBe(false);

    // Write intent performs the mechanical repair and verifies.
    const repaired = await resolveLocalContext(options(value, "write"), {
      readBinding: async () => ({ status: "unbound" }),
      recordRemoteBinding: vi.fn(),
      verifyTree: verifyTreeRoot,
    });
    expect(repaired.verified).toBe(true);
    expect(readFileSync(join(value.localRoot, "NODE.md"), "utf8")).toContain("agent-local");
    expect(verifyTreeRoot(value.localRoot).ok).toBe(true);
  });

  it("fails closed on corrupt source state before consulting the server", async () => {
    const value = fixture();
    writeFileSync(join(value.workspaceRoot, ".first-tree-workspace", "source-state.json"), "{broken");
    const readBinding = vi.fn(async () => ({ status: "unbound" as const }));

    await expect(
      resolveLocalContext(options(value), { readBinding, recordRemoteBinding: vi.fn(), verifyTree: verifyTreeRoot }),
    ).rejects.toMatchObject({ code: "LOCAL_CONTEXT_FROZEN" });
    expect(readBinding).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a dangling symlink",
      setup: (path: string) => symlinkSync(`${path}.missing`, path),
    },
    {
      label: "a directory",
      setup: (path: string) => mkdirSync(path),
    },
    {
      label: "a future schema version",
      setup: (path: string) =>
        writeFileSync(
          path,
          JSON.stringify({
            branch: "main",
            observedAt: new Date().toISOString(),
            remoteObserved: true,
            repoUrl: "https://github.com/acme/context.git",
            schemaVersion: 2,
          }),
        ),
    },
  ])("fails closed when source state is $label", async ({ setup }) => {
    const value = fixture();
    const statePath = join(value.workspaceRoot, ".first-tree-workspace", "source-state.json");
    setup(statePath);
    const readBinding = vi.fn(async () => ({ status: "unbound" as const }));

    await expect(
      resolveLocalContext(options(value), { readBinding, recordRemoteBinding: vi.fn(), verifyTree: verifyTreeRoot }),
    ).rejects.toMatchObject({ code: "LOCAL_CONTEXT_FROZEN" });
    expect(readBinding).not.toHaveBeenCalled();
  });

  it("records a newly observed remote binding through the shared async hook before refusing Local", async () => {
    const value = fixture();
    const recordRemoteBinding = vi.fn(async () => undefined);
    await expect(
      resolveLocalContext(options(value), {
        readBinding: async () => ({
          status: "bound",
          branch: "main",
          repoUrl: "https://github.com/acme/context.git",
        }),
        recordRemoteBinding,
        verifyTree: verifyTreeRoot,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CONTEXT_FROZEN" });
    expect(recordRemoteBinding).toHaveBeenCalledWith({
      status: "bound",
      branch: "main",
      repoUrl: "https://github.com/acme/context.git",
    });
  });

  it("rechecks Server binding after scaffold/verify and records a late remote flip", async () => {
    const value = fixture();
    const readBinding = vi.fn().mockResolvedValueOnce({ status: "unbound" }).mockResolvedValueOnce({
      status: "bound",
      branch: "main",
      repoUrl: "https://github.com/acme/context.git",
    });
    const recordRemoteBinding = vi.fn(async () => undefined);

    await expect(
      resolveLocalContext(options(value), {
        readBinding,
        recordRemoteBinding,
        verifyTree: verifyTreeRoot,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CONTEXT_FROZEN" });
    expect(readBinding).toHaveBeenCalledTimes(2);
    expect(recordRemoteBinding).toHaveBeenCalledTimes(1);
  });

  it("does not follow a symlink introduced at a scaffold directory boundary", async () => {
    const value = fixture();
    const outside = mkdtempSync(join(tmpdir(), "ft-local-context-outside-"));
    roots.push(outside);
    mkdirSync(value.localRoot);
    symlinkSync(outside, join(value.localRoot, "members"));

    await expect(
      resolveLocalContext(options(value), {
        readBinding: async () => ({ status: "unbound" }),
        recordRemoteBinding: vi.fn(),
        verifyTree: verifyTreeRoot,
      }),
    ).rejects.toBeInstanceOf(LocalContextError);
    expect(() => readFileSync(join(outside, "NODE.md"), "utf8")).toThrow();
  });

  it("allows write repair but refuses read when the live Tree is mechanically invalid", async () => {
    const value = fixture();
    const deps = {
      readBinding: async () => ({ status: "unbound" as const }),
      recordRemoteBinding: vi.fn(),
      verifyTree: () => ({ ok: false }),
    };
    const writeResult = await resolveLocalContext(options(value, "write"), deps);
    expect(writeResult).toMatchObject({ repairOnly: true, verified: false });
    await expect(resolveLocalContext(options(value, "read"), deps)).rejects.toMatchObject({
      code: "LOCAL_CONTEXT_TREE_INVALID",
    });
  });

  it("rejects identity, path, and remote-latch mismatches without consulting Git", async () => {
    const value = fixture();
    const mismatched = {
      ...options(value),
      agentName: "other-agent",
    };
    await expect(
      resolveLocalContext(mismatched, {
        readBinding: async () => ({ status: "unbound" }),
        recordRemoteBinding: vi.fn(),
        verifyTree: verifyTreeRoot,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CONTEXT_IDENTITY_MISMATCH" });

    const first = resolveLocalContext(options(value, "write"), {
      readBinding: async () => ({ status: "unbound" }),
      recordRemoteBinding: vi.fn(),
      verifyTree: verifyTreeRoot,
    });
    const second = resolveLocalContext(options(value, "write"), {
      readBinding: async () => ({ status: "unbound" }),
      recordRemoteBinding: vi.fn(),
      verifyTree: verifyTreeRoot,
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.path).toBe(realpathSync(value.localRoot));
    expect(b.path).toBe(realpathSync(value.localRoot));
  });
});
