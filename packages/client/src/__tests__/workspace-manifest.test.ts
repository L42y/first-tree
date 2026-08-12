import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_REPOS_DIRNAME } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_TREE_DIRNAME,
  ensureWorkspaceManifest,
  RETIRED_WORKSPACE_MANIFEST_FILENAME,
  retireWorkspaceManifest,
} from "../runtime/workspace-manifest.js";

describe("ensureWorkspaceManifest", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "ft-ws-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    vi.doUnmock("@first-tree/shared");
    vi.resetModules();
  });

  const manifestPath = () => join(ws, ".first-tree", "workspace.json");
  const treeDirPath = () => join(ws, CONTEXT_TREE_DIRNAME);

  it("writes .first-tree/workspace.json naming the tree dir + sources + sourcesRoot", () => {
    ensureWorkspaceManifest(ws, ["app", "api"]);
    expect(existsSync(manifestPath())).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app", "api"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
    // sourcesRoot pins the source clones one level down under source-repos/.
    expect(SOURCE_REPOS_DIRNAME).toBe("source-repos");
  });

  it("is idempotent across repeated calls", () => {
    ensureWorkspaceManifest(ws, ["app"]);
    expect(() => ensureWorkspaceManifest(ws, ["app"])).not.toThrow();
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("writes a valid manifest with no sources (tree-bound agent, no repos)", () => {
    ensureWorkspaceManifest(ws, []);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: [],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("writes tree + sourcesRoot with NO sources key when the source set is unresolved (null)", () => {
    // Unresolved must not publish unknown as resolved-empty: the sources key
    // stays absent, keeping the tree discoverable without claiming zero
    // sources.
    ensureWorkspaceManifest(ws, null);
    expect(existsSync(manifestPath())).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("keeps resolved-empty ([]) distinguishable from unresolved (key absent) on disk", () => {
    ensureWorkspaceManifest(ws, []);
    const resolvedEmpty = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    expect(resolvedEmpty.sources).toEqual([]);

    ensureWorkspaceManifest(ws, null);
    const stillResolvedEmpty = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    // Last-known-good preservation: null over a resolved-empty manifest keeps
    // the declared (empty) list rather than reverting to absent.
    expect(stillResolvedEmpty.sources).toEqual([]);

    rmSync(manifestPath());
    ensureWorkspaceManifest(ws, null);
    const unresolved = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    expect("sources" in unresolved).toBe(false);
  });

  it("preserves last-known sources across a transient unresolved run", () => {
    ensureWorkspaceManifest(ws, ["api"]);
    ensureWorkspaceManifest(ws, null);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["api"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("refills sources normally once the source set resolves again", () => {
    ensureWorkspaceManifest(ws, ["api"]);
    ensureWorkspaceManifest(ws, null);
    ensureWorkspaceManifest(ws, ["api", "web"]);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["api", "web"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("omits sources when unresolved and the existing manifest is corrupt", () => {
    mkdirSync(join(ws, ".first-tree"), { recursive: true });
    writeFileSync(manifestPath(), "{ not valid json", "utf-8");
    ensureWorkspaceManifest(ws, null);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("drops a source with a nested localPath instead of dropping the whole manifest", () => {
    const logs: string[] = [];
    ensureWorkspaceManifest(ws, ["app", "nested/path", "api"], (msg) => logs.push(msg));
    // The valid sources still bind; the nested one is omitted (still on disk).
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app", "api"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
    expect(logs.some((l) => l.includes('dropping source "nested/path"'))).toBe(true);
  });

  it("writes a source named context-tree (lives under source-repos/, no tree collision)", () => {
    // With sourcesRoot set, a source repo literally named `context-tree` lives
    // at `<ws>/source-repos/context-tree` — a different namespace from the tree
    // at `<ws>/context-tree` — so it is a valid source, NOT a reason to drop the
    // whole manifest and leave a tree-bound agent with no workspace.json.
    ensureWorkspaceManifest(ws, [CONTEXT_TREE_DIRNAME]);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: [CONTEXT_TREE_DIRNAME],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("creates no context-tree entry on disk — the agent materialises the clone itself", () => {
    ensureWorkspaceManifest(ws, ["app"]);
    expect(existsSync(manifestPath())).toBe(true);
    // The manifest may name a tree dir that does not exist yet; the runtime
    // must not create a directory or symlink (even a dangling one) at that path.
    expect(lstatSync(treeDirPath(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("logs and continues when the workspace state dir cannot be created", () => {
    const fileWorkspace = join(ws, "not-a-directory");
    const logs: string[] = [];
    writeFileSync(fileWorkspace, "already a file");

    expect(() => ensureWorkspaceManifest(fileWorkspace, ["app"], (msg) => logs.push(msg))).not.toThrow();

    expect(logs.some((line) => line.includes("workspace manifest write failed"))).toBe(true);
  });

  it("logs and skips filesystem writes when manifest validation fails", async () => {
    vi.resetModules();
    vi.doMock("@first-tree/shared", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@first-tree/shared")>();
      return {
        ...actual,
        workspaceManifestSchema: {
          parse: () => {
            throw new Error("schema rejected manifest");
          },
        },
      };
    });
    const mod = await import("../runtime/workspace-manifest.js");
    const logs: string[] = [];

    expect(() => mod.ensureWorkspaceManifest(ws, ["app"], (msg) => logs.push(msg))).not.toThrow();

    expect(existsSync(manifestPath())).toBe(false);
    expect(logs.some((line) => line.includes("workspace manifest skipped: schema rejected manifest"))).toBe(true);
  });
});

describe("retireWorkspaceManifest", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "ft-ws-retire-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const manifestPath = () => join(ws, ".first-tree", "workspace.json");
  const retiredPath = () => join(ws, ".first-tree", RETIRED_WORKSPACE_MANIFEST_FILENAME);

  it("renames the manifest to workspace.json.retired", () => {
    expect(RETIRED_WORKSPACE_MANIFEST_FILENAME).toBe("workspace.json.retired");
    ensureWorkspaceManifest(ws, ["app"]);

    retireWorkspaceManifest(ws);

    expect(existsSync(manifestPath())).toBe(false);
    expect(JSON.parse(readFileSync(retiredPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("overwrites a prior retired file on repeated retirements", () => {
    mkdirSync(join(ws, ".first-tree"), { recursive: true });
    writeFileSync(retiredPath(), "prior retired manifest\n");
    ensureWorkspaceManifest(ws, ["api"]);

    retireWorkspaceManifest(ws);

    expect(existsSync(manifestPath())).toBe(false);
    expect(JSON.parse(readFileSync(retiredPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["api"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("is an idempotent no-op when no manifest exists", () => {
    expect(() => retireWorkspaceManifest(ws)).not.toThrow();
    expect(existsSync(retiredPath())).toBe(false);
  });

  it("never touches the context-tree/ checkout", () => {
    const treeDir = join(ws, CONTEXT_TREE_DIRNAME);
    mkdirSync(treeDir, { recursive: true });
    writeFileSync(join(treeDir, "NODE.md"), "local state\n");
    ensureWorkspaceManifest(ws, ["app"]);

    retireWorkspaceManifest(ws);

    expect(readFileSync(join(treeDir, "NODE.md"), "utf-8")).toBe("local state\n");
    expect(existsSync(manifestPath())).toBe(false);
    expect(existsSync(retiredPath())).toBe(true);
  });

  it("logs and continues when the rename fails", () => {
    // A directory at the retired path cannot be overwritten by renameSync.
    ensureWorkspaceManifest(ws, ["app"]);
    mkdirSync(join(ws, ".first-tree", RETIRED_WORKSPACE_MANIFEST_FILENAME), { recursive: true });
    const logs: string[] = [];

    expect(() => retireWorkspaceManifest(ws, (msg) => logs.push(msg))).not.toThrow();

    expect(logs.some((line) => line.includes("workspace manifest retirement failed"))).toBe(true);
    expect(existsSync(manifestPath())).toBe(true);
  });
});
