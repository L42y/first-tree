import {
  existsSync,
  lstatSync,
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
import { SOURCE_REPOS_DIRNAME } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUNTIME_STATE_DIRNAME,
  CONTEXT_TREE_DIRNAME,
  ensureWorkspaceManifest,
  LOCAL_CONTEXT_DIRNAME,
  SOURCE_STATE_FILENAME,
} from "../runtime/workspace-manifest.js";

describe("ensureWorkspaceManifest", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(realpathSync(tmpdir()), "ft-ws-"));
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

  it("allows a Local manifest when a legacy remote tree name is on disk but the latch is absent", () => {
    ensureWorkspaceManifest(ws, ["app"]);
    const logs: string[] = [];
    ensureWorkspaceManifest(ws, ["app"], (msg) => logs.push(msg), LOCAL_CONTEXT_DIRNAME);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: LOCAL_CONTEXT_DIRNAME,
      sources: ["app"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
    expect(logs).toEqual([]);
  });

  it("refuses a local-context manifest after a remote-observed latch is on disk", () => {
    mkdirSync(join(ws, AGENT_RUNTIME_STATE_DIRNAME), { recursive: true });
    writeFileSync(
      join(ws, AGENT_RUNTIME_STATE_DIRNAME, SOURCE_STATE_FILENAME),
      `${JSON.stringify({
        schemaVersion: 1,
        remoteObserved: true,
        observedAt: "2026-08-13T00:00:00.000Z",
        repoUrl: "git@github.com:acme/tree.git",
        branch: "main",
      })}\n`,
    );
    const logs: string[] = [];
    ensureWorkspaceManifest(ws, ["app"], (msg) => logs.push(msg), LOCAL_CONTEXT_DIRNAME);
    expect(existsSync(manifestPath())).toBe(false);
    expect(logs.some((line) => line.includes("refusing Local publication"))).toBe(true);
  });

  it("refuses a local-context manifest when source-state exists but is unreadable", () => {
    mkdirSync(join(ws, AGENT_RUNTIME_STATE_DIRNAME), { recursive: true });
    writeFileSync(join(ws, AGENT_RUNTIME_STATE_DIRNAME, SOURCE_STATE_FILENAME), "{broken");
    const logs: string[] = [];
    ensureWorkspaceManifest(ws, ["app"], (msg) => logs.push(msg), LOCAL_CONTEXT_DIRNAME);
    expect(existsSync(manifestPath())).toBe(false);
    expect(logs.some((line) => line.includes("refusing Local publication"))).toBe(true);
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

  it("does not write workspace.json through a .first-tree symlink", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "ft-ws-outside-"));
    const outsideManifest = join(outsideDir, "workspace.json");
    writeFileSync(outsideManifest, "external-manifest\n");
    symlinkSync(outsideDir, join(ws, ".first-tree"));
    const logs: string[] = [];

    expect(() => ensureWorkspaceManifest(ws, ["app"], (msg) => logs.push(msg))).not.toThrow();

    expect(lstatSync(join(ws, ".first-tree")).isSymbolicLink()).toBe(true);
    expect(readFileSync(outsideManifest, "utf-8")).toBe("external-manifest\n");
    expect(logs.some((line) => line.includes("workspace manifest write failed"))).toBe(true);
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
