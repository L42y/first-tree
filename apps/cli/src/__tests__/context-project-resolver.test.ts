import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCodexProjectlessPath,
  inspectContextClientPreflight,
  inspectContextSetupLocation,
  resolveProviderProject,
  resolveSessionContextProject,
} from "../core/context-integration/client-preflight.js";

describe("Context project resolver", () => {
  it.each([
    ["win32", "C:\\Users\\alice\\Documents\\Codex\\2026-07-30\\ni-de", "C:\\Users\\alice"],
    ["darwin", "/Users/alice/Documents/Codex/2026-07-30/d", "/Users/alice"],
    ["darwin", "/Users/alice/Documents/Codex/2026-07-30/d/nested/source", "/Users/alice"],
  ] as const)("classifies the documented Codex scratch layout on %s", (platform, cwd, home) => {
    expect(
      classifyCodexProjectlessPath(cwd, platform === "win32" ? { USERPROFILE: home } : {}, { platform, home }),
    ).toBe(true);
  });

  it("does not classify near-matches or ordinary multi-repo parent directories as pathless", () => {
    expect(
      classifyCodexProjectlessPath(
        "/Users/alice/Documents/Codex/not-a-date/project",
        {},
        { platform: "darwin", home: "/Users/alice" },
      ),
    ).toBe(false);
    expect(
      classifyCodexProjectlessPath("/Users/alice/work/multi-repo", {}, { platform: "darwin", home: "/Users/alice" }),
    ).toBe(false);
    expect(
      classifyCodexProjectlessPath(
        "/Users/alice/Documents/Codex/2026-07-30",
        {},
        { platform: "darwin", home: "/Users/alice" },
      ),
    ).toBe(false);
    expect(
      classifyCodexProjectlessPath(
        "/Users/alice/Documents/Codex-project/2026-07-30/d",
        {},
        { platform: "darwin", home: "/Users/alice" },
      ),
    ).toBe(false);
  });

  it("classifies Windows OneDrive Documents roots without matching sibling paths", () => {
    const env = {
      USERPROFILE: "C:\\Users\\alice",
      OneDrive: "D:\\OneDrive - Acme",
    };
    expect(
      classifyCodexProjectlessPath("D:\\OneDrive - Acme\\Documents\\Codex\\2026-07-30\\d", env, {
        platform: "win32",
      }),
    ).toBe(true);
    expect(
      classifyCodexProjectlessPath("D:\\OneDrive - Acme\\Documents\\Codex-copy\\2026-07-30\\d", env, {
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("shows a Codex scratch setup as its real temporary directory before scope selection", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-scratch-binding-"));
    const scratch = join(root, "home", "Documents", "Codex", "2026-07-30", "d");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(join(root, "config"));
    writeFileSync(
      join(root, "config", "credentials.json"),
      JSON.stringify({ accessToken: "access", refreshToken: "refresh", serverUrl: "https://first-tree.test" }),
    );
    const previousHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = root;
    try {
      const resolution = inspectContextSetupLocation("codex", {
        cwd: scratch,
        classifierOptions: { platform: process.platform, home: join(root, "home") },
      });
      expect(resolution).toMatchObject({
        project: { kind: "path", root: scratch },
        directory: scratch,
        directoryAvailable: true,
        temporaryDirectory: true,
      });
    } finally {
      if (previousHome === undefined) delete process.env.FIRST_TREE_HOME;
      else process.env.FIRST_TREE_HOME = previousHome;
    }
  });

  it("canonicalizes Codex cwd before scratch classification", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-project-symlink-"));
    const home = join(root, "home");
    const scratch = join(home, "Documents", "Codex", "2026-07-30", "scratch");
    const ordinary = join(root, "ordinary");
    const externalLink = join(root, "scratch-link");
    const scratchLink = join(scratch, "ordinary-link");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(ordinary);
    symlinkSync(scratch, externalLink);
    symlinkSync(ordinary, scratchLink);

    expect(
      resolveProviderProject("codex", { cwd: externalLink }, {}, { platform: process.platform, home }),
    ).toMatchObject({ kind: "pathless", source: "codex_documents_v1" });
    expect(
      resolveProviderProject("codex", { cwd: scratchLink }, {}, { platform: process.platform, home }),
    ).toMatchObject({ kind: "path", project: { root: ordinary } });
    expect(
      resolveProviderProject("codex", { cwd: join(root, "missing") }, {}, { platform: process.platform, home }),
    ).toMatchObject({ kind: "unknown", source: "path_unreadable" });
  });

  it("canonicalizes a redirected Documents base before Codex scratch classification", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-redirected-documents-"));
    const home = join(root, "home");
    const redirectedDocuments = join(root, "redirected-documents");
    const scratch = join(redirectedDocuments, "Codex", "2026-07-30", "scratch");
    mkdirSync(home);
    mkdirSync(scratch, { recursive: true });
    symlinkSync(redirectedDocuments, join(home, "Documents"));

    expect(
      resolveProviderProject(
        "codex",
        { cwd: join(home, "Documents", "Codex", "2026-07-30", "scratch") },
        {},
        {
          platform: process.platform,
          home,
        },
      ),
    ).toMatchObject({ kind: "pathless", source: "codex_documents_v1" });
  });

  it("accepts only readable directories as path projects", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-project-directory-"));
    const directory = join(root, "empty-project");
    const file = join(root, "not-a-project");
    mkdirSync(directory);
    writeFileSync(file, "not a directory\n");

    expect(resolveProviderProject("codex", { cwd: directory })).toMatchObject({
      kind: "path",
      project: { root: directory },
    });
    expect(resolveProviderProject("codex", { cwd: file })).toMatchObject({
      kind: "unknown",
      source: "path_unreadable",
    });
    expect(resolveProviderProject("codex", { cwd: join(root, "missing") })).toMatchObject({
      kind: "unknown",
      source: "path_unreadable",
    });
    expect(
      resolveProviderProject(
        "codex",
        { cwd: directory },
        {},
        {
          stat: () => {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          },
        },
      ),
    ).toMatchObject({ kind: "unknown", source: "path_unreadable" });
  });

  it("reports an existing file project selector as project_unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-project-file-"));
    const file = join(root, "not-a-project");
    const previousHome = process.env.FIRST_TREE_HOME;
    mkdirSync(join(root, "config"));
    writeFileSync(file, "not a directory\n");
    writeFileSync(
      join(root, "config", "credentials.json"),
      JSON.stringify({ accessToken: "access", refreshToken: "refresh", serverUrl: "https://first-tree.test" }),
    );
    process.env.FIRST_TREE_HOME = root;
    try {
      expect(() => inspectContextClientPreflight("codex", { projectRoot: file })).toThrowError(
        expect.objectContaining({ code: "project_unreadable" }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.FIRST_TREE_HOME;
      else process.env.FIRST_TREE_HOME = previousHome;
    }
  });

  it("uses CLAUDE_PROJECT_DIR instead of mutable hook cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-project-"));
    mkdirSync(join(root, "nested"));
    expect(
      resolveProviderProject("claude-code", { cwd: join(root, "nested") }, { CLAUDE_PROJECT_DIR: root }),
    ).toMatchObject({
      kind: "path",
      project: { kind: "path", root },
      source: "claude_project_dir",
    });
  });

  it("caches the first Codex classification by session id across cwd changes", () => {
    const pluginData = mkdtempSync(join(tmpdir(), "codex-project-cache-"));
    const first = mkdtempSync(join(tmpdir(), "codex-project-first-"));
    const second = mkdtempSync(join(tmpdir(), "codex-project-second-"));
    const environment = { PLUGIN_DATA: pluginData };
    expect(resolveSessionContextProject("codex", { sessionId: "session-1", cwd: first }, environment)).toMatchObject({
      kind: "path",
      project: { root: first },
    });
    expect(resolveSessionContextProject("codex", { sessionId: "session-1", cwd: second }, environment)).toMatchObject({
      kind: "path",
      project: { root: first },
    });
  });

  it("keeps a pathless Codex session pathless after shell cwd changes and accepts the explicit manual selector", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-pathless-session-"));
    const home = join(root, "home");
    const scratch = join(home, "Documents", "Codex", "2026-07-30", "scratch");
    const outside = join(root, "source");
    const pluginData = join(root, "plugin-data");
    const previousHome = process.env.FIRST_TREE_HOME;
    mkdirSync(scratch, { recursive: true });
    mkdirSync(outside);
    mkdirSync(join(root, "config"));
    writeFileSync(
      join(root, "config", "credentials.json"),
      JSON.stringify({ accessToken: "access", refreshToken: "refresh", serverUrl: "https://first-tree.test" }),
    );
    const environment = { PLUGIN_DATA: pluginData };
    expect(
      resolveSessionContextProject("codex", { sessionId: "pathless-session", cwd: scratch }, environment, {
        platform: process.platform,
        home,
      }),
    ).toMatchObject({ kind: "pathless" });
    expect(
      resolveSessionContextProject("codex", { sessionId: "pathless-session", cwd: outside }, environment, {
        platform: process.platform,
        home,
      }),
    ).toMatchObject({ kind: "pathless" });

    process.env.FIRST_TREE_HOME = root;
    try {
      expect(inspectContextClientPreflight("codex", { cwd: outside, pathless: true })).toMatchObject({
        kind: "pathless",
        source: "explicit_pathless",
      });
    } finally {
      if (previousHome === undefined) delete process.env.FIRST_TREE_HOME;
      else process.env.FIRST_TREE_HOME = previousHome;
    }
  });
});
