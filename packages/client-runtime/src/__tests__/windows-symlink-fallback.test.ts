import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  symlinkSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    symlinkSync: fsMocks.symlinkSync,
  };
});

import { writeAgentBriefing } from "../runtime/bootstrap.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function symlinkError(code: "EPERM" | "EACCES"): NodeJS.ErrnoException {
  return Object.assign(new Error(`symlink ${code}`), { code });
}

describe("Windows symlink fallbacks", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "ft-win-symlink-"));
    fsMocks.symlinkSync.mockReset();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    setPlatform(originalPlatform);
  });

  it.each([
    "EPERM",
    "EACCES",
  ] as const)("writes CLAUDE.md as a regular file on Windows %s and keeps later briefing updates in sync", (code) => {
    setPlatform("win32");
    fsMocks.symlinkSync.mockImplementation(() => {
      throw symlinkError(code);
    });
    const workspace = join(tmpBase, `briefing-${code}`);
    mkdirSync(workspace, { recursive: true });

    writeAgentBriefing(workspace, "first briefing");
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("first briefing");
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf-8")).toBe("first briefing");
    expect(lstatSync(join(workspace, "CLAUDE.md")).isFile()).toBe(true);
    expect(lstatSync(join(workspace, "CLAUDE.md")).isSymbolicLink()).toBe(false);

    writeAgentBriefing(workspace, "updated briefing");
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("updated briefing");
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf-8")).toBe("updated briefing");
  });

  it("does not swallow non-Windows symlink permission errors", () => {
    setPlatform("linux");
    fsMocks.symlinkSync.mockImplementation(() => {
      throw symlinkError("EACCES");
    });
    const workspace = join(tmpBase, "briefing-linux-error");
    mkdirSync(workspace, { recursive: true });

    expect(() => writeAgentBriefing(workspace, "briefing")).toThrow("symlink EACCES");
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(false);
  });
});
