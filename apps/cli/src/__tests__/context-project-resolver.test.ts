import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCodexProjectlessPath,
  resolveProviderProject,
  resolveSessionContextProject,
} from "../core/context-integration/client-preflight.js";
import {
  type ContextBindingStorePaths,
  readContextIntegrationConfig,
  writeContextBinding,
} from "../core/context-integration/context-binding-store.js";

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

  it("persists a Codex scratch setup as pathless through the shared resolver result", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-scratch-binding-"));
    const scratch = join(root, "home", "Documents", "Codex", "2026-07-30", "d");
    mkdirSync(scratch, { recursive: true });
    const paths: ContextBindingStorePaths = {
      configPath: join(root, "config", "context.yaml"),
      lockPath: join(root, "state", "context", "install.lock"),
    };
    const resolution = resolveProviderProject(
      "codex",
      { cwd: scratch },
      {},
      { platform: process.platform, home: join(root, "home") },
    );
    expect(resolution).toMatchObject({
      kind: "pathless",
      project: { kind: "pathless" },
      source: "codex_documents_v1",
    });
    if (resolution.kind !== "pathless") throw new Error("expected pathless project");

    writeContextBinding(
      {
        provider: "codex",
        project: resolution.project,
        organizationId: "org_acme",
      },
      { paths },
    );
    expect(readContextIntegrationConfig(paths).bindings).toEqual([
      {
        provider: "codex",
        project: { kind: "pathless" },
        organizationId: "org_acme",
      },
    ]);
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
});
