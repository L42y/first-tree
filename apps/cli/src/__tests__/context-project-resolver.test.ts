import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCodexProjectlessPath,
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
