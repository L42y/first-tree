import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import { migrateLegacyRuntimeLayout, resolveAgentContextTreeBinding } from "../runtime/bootstrap.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

describe("bootstrap edge coverage", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(realpathSync(tmpdir()), "ft-bootstrap-extra-"));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.doUnmock("node:fs");
    vi.resetModules();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("resolves only bound payloads that include an explicit valid branch", async () => {
    const logs: string[] = [];
    const workspace = join(tmpBase, "bound-workspace");
    const nullBranchSdk = {
      getAgentContextTreeConfig: vi.fn(async () => ({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: null,
        provider: "github",
      })),
    } as unknown as FirstTreeHubSDK;

    await expect(resolveAgentContextTreeBinding(nullBranchSdk, workspace, (msg) => logs.push(msg))).resolves.toBeNull();

    const missingBranchSdk = {
      getAgentContextTreeConfig: vi.fn(async () => ({
        bindingState: "bound",
        repo: "ssh://git@github.com/acme/context-tree.git",
        provider: "github",
      })),
    } as unknown as FirstTreeHubSDK;
    await expect(
      resolveAgentContextTreeBinding(missingBranchSdk, workspace, (msg) => logs.push(msg)),
    ).resolves.toBeNull();

    const namedBranchSdk = {
      getAgentContextTreeConfig: vi.fn(async () => ({
        bindingState: "bound",
        repo: "https://github.com/acme/context-tree.git",
        branch: "release/2026-07",
        provider: "github",
      })),
    } as unknown as FirstTreeHubSDK;
    await expect(resolveAgentContextTreeBinding(namedBranchSdk, workspace, (msg) => logs.push(msg))).resolves.toEqual({
      path: join(workspace, "context-tree"),
      repoUrl: "https://github.com/acme/context-tree.git",
      branch: "release/2026-07",
    });

    expect(logs).toEqual([
      "Context source unresolved: missing, conflicting, or unreadable bindingState",
      "Context source unresolved: missing, conflicting, or unreadable bindingState",
    ]);
  });

  it("skips unconfigured, invalid, and unreachable context tree bindings without logging raw values", async () => {
    const logs: string[] = [];
    const workspace = join(tmpBase, "skip-workspace");

    const unconfiguredSdk = {
      getAgentContextTreeConfig: vi.fn(async () => ({ bindingState: "unbound", repo: null, branch: null })),
    } as unknown as FirstTreeHubSDK;
    await expect(
      resolveAgentContextTreeBinding(unconfiguredSdk, workspace, (msg) => logs.push(msg)),
    ).resolves.toBeNull();

    const invalidRepo = "http://private.example.invalid/secret-tree.git";
    const invalidRepoSdk = {
      getAgentContextTreeConfig: vi.fn(async () => ({
        bindingState: "bound",
        repo: invalidRepo,
        branch: "main",
        provider: null,
      })),
    } as unknown as FirstTreeHubSDK;
    await expect(
      resolveAgentContextTreeBinding(invalidRepoSdk, workspace, (msg) => logs.push(msg)),
    ).resolves.toBeNull();

    const invalidBranch = "private..branch";
    const invalidBranchSdk = {
      getAgentContextTreeConfig: vi.fn(async () => ({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: invalidBranch,
        provider: null,
      })),
    } as unknown as FirstTreeHubSDK;
    await expect(
      resolveAgentContextTreeBinding(invalidBranchSdk, workspace, (msg) => logs.push(msg)),
    ).resolves.toBeNull();

    const failingSdk = {
      getAgentContextTreeConfig: vi.fn(async () => {
        throw new Error(`server returned ${invalidRepo} on ${invalidBranch}`);
      }),
    } as unknown as FirstTreeHubSDK;
    await expect(resolveAgentContextTreeBinding(failingSdk, workspace, (msg) => logs.push(msg))).resolves.toBeNull();

    expect(logs).toEqual([
      "Context source unresolved: missing, conflicting, or unreadable bindingState",
      "Context source unresolved: missing, conflicting, or unreadable bindingState",
      "Context source unresolved: missing, conflicting, or unreadable bindingState",
      "Context source unresolved: failed to fetch agent Context Tree config",
    ]);
    expect(logs.join("\n")).not.toContain(invalidRepo);
    expect(logs.join("\n")).not.toContain(invalidBranch);
  });

  it("merges legacy runtime directories recursively without overwriting newer target files", () => {
    const workspace = join(tmpBase, "workspace");
    mkdirSync(join(workspace, ".agent", "nested"), { recursive: true });
    mkdirSync(join(workspace, ".agent", "new-dir"), { recursive: true });
    mkdirSync(join(workspace, ".first-tree-workspace", "nested"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "nested", "moved.txt"), "legacy nested\n");
    writeFileSync(join(workspace, ".agent", "new-dir", "payload.txt"), "legacy dir\n");
    writeFileSync(join(workspace, ".agent", "loose.txt"), "legacy loose\n");
    writeFileSync(join(workspace, ".agent", "conflict.txt"), "legacy conflict\n");
    writeFileSync(join(workspace, ".first-tree-workspace", "conflict.txt"), "current conflict\n");

    const runtimeDir = migrateLegacyRuntimeLayout(workspace);

    expect(runtimeDir).toBe(realpathSync(join(workspace, ".first-tree-workspace")));
    expect(readFileSync(join(runtimeDir, "nested", "moved.txt"), "utf8")).toBe("legacy nested\n");
    expect(readFileSync(join(runtimeDir, "new-dir", "payload.txt"), "utf8")).toBe("legacy dir\n");
    expect(readFileSync(join(runtimeDir, "loose.txt"), "utf8")).toBe("legacy loose\n");
    expect(readFileSync(join(runtimeDir, "conflict.txt"), "utf8")).toBe("current conflict\n");
    expect(existsSync(join(workspace, ".agent"))).toBe(false);
  });

  it("throws non-ENOENT lstat failures while checking CLAUDE.md", async () => {
    const workspace = join(tmpBase, "lstat-error");
    mkdirSync(workspace, { recursive: true });
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        lstatSync: () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      };
    });
    const mod = await import("../runtime/bootstrap.js");

    expect(() => mod.ensureClaudeMdSymlink(workspace, "briefing")).toThrow("permission denied");
  });

  it("cleans up and rethrows when symlink rename fails", async () => {
    const workspace = join(tmpBase, "rename-error");
    mkdirSync(workspace, { recursive: true });
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        renameSync: () => {
          throw new Error("rename denied");
        },
      };
    });
    const mod = await import("../runtime/bootstrap.js");

    expect(() => mod.ensureClaudeMdSymlink(workspace, "briefing")).toThrow("rename denied");
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(false);
  });

  it("cleans up and rethrows when the Windows fallback file rename fails", async () => {
    const workspace = join(tmpBase, "fallback-rename-error");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "briefing\n");
    setPlatform("win32");
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        symlinkSync: () => {
          throw Object.assign(new Error("symlink denied"), { code: "EPERM" });
        },
        renameSync: () => {
          throw new Error("fallback rename denied");
        },
      };
    });
    const mod = await import("../runtime/bootstrap.js");

    expect(() => mod.ensureClaudeMdSymlink(workspace)).toThrow("fallback rename denied");
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(false);
  });
});
