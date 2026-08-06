import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanAgentWorkspaces } from "../runtime/workspace-maintenance.js";

function writeRegistry(
  dataDir: string,
  agentName: string,
  entries: Record<string, { status: string; claudeSessionId?: string }>,
): void {
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const payload = {
    version: 1,
    entries: Object.fromEntries(
      Object.entries(entries).map(([chatId, entry]) => [
        chatId,
        {
          claudeSessionId: entry.claudeSessionId ?? `sess-${chatId}`,
          lastActivity: new Date(1_700_000_000_000).toISOString(),
          status: entry.status,
        },
      ]),
    ),
  };
  writeFileSync(join(sessionsDir, `${agentName}.json`), JSON.stringify(payload), "utf-8");
}

describe("cleanAgentWorkspaces", () => {
  let dataDir = "";

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = "";
    vi.restoreAllMocks();
  });

  it("returns missing-root when the workspaces directory does not exist", () => {
    dataDir = mkdtempSync(join(tmpdir(), "ft-clean-missing-"));
    const result = cleanAgentWorkspaces({ dataDir, ttlMs: 0 });
    expect(result).toEqual({ kind: "missing-root" });
  });

  it("orchestrates all agents and maps removed chat ids with active-vs-evicted selection", () => {
    dataDir = mkdtempSync(join(tmpdir(), "ft-clean-all-"));
    mkdirSync(join(dataDir, "workspaces", "nova"), { recursive: true });
    mkdirSync(join(dataDir, "workspaces", "mira"), { recursive: true });
    writeRegistry(dataDir, "nova", {
      "chat-active": { status: "active" },
      "chat-suspended": { status: "suspended" },
      "chat-evicted": { status: "evicted" },
    });
    writeRegistry(dataDir, "mira", {
      "chat-only-active": { status: "active" },
    });

    const cleanFn = vi.fn((workspaceRoot: string, activeChatIds: Set<string>, ttlMs: number) => {
      if (workspaceRoot === join(dataDir, "workspaces", "nova")) {
        expect(activeChatIds).toEqual(new Set(["chat-active", "chat-suspended"]));
        expect(ttlMs).toBe(3 * 24 * 60 * 60 * 1000);
        return ["chat-old"];
      }
      expect(workspaceRoot).toBe(join(dataDir, "workspaces", "mira"));
      expect(activeChatIds).toEqual(new Set(["chat-only-active"]));
      return [];
    });

    const result = cleanAgentWorkspaces({
      dataDir,
      ttlMs: 3 * 24 * 60 * 60 * 1000,
      cleanWorkspacesFn: cleanFn,
    });

    expect(result).toEqual({
      kind: "cleaned",
      removed: [{ agentName: "nova", chatId: "chat-old" }],
    });
    expect(cleanFn).toHaveBeenCalledTimes(2);
  });

  it("limits orchestration to a single named agent", () => {
    dataDir = mkdtempSync(join(tmpdir(), "ft-clean-one-"));
    mkdirSync(join(dataDir, "workspaces", "nova"), { recursive: true });
    mkdirSync(join(dataDir, "workspaces", "mira"), { recursive: true });
    writeRegistry(dataDir, "nova", { "chat-a": { status: "active" } });
    writeRegistry(dataDir, "mira", { "chat-b": { status: "active" } });

    const cleanFn = vi.fn((_workspaceRoot: string, _activeChatIds: Set<string>, _ttlMs: number): string[] => [
      "chat-stale",
    ]);
    const result = cleanAgentWorkspaces({
      agentName: "nova",
      dataDir,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      cleanWorkspacesFn: cleanFn,
    });

    expect(cleanFn).toHaveBeenCalledTimes(1);
    expect(cleanFn.mock.calls[0]?.[0]).toBe(join(dataDir, "workspaces", "nova"));
    expect(result).toEqual({
      kind: "cleaned",
      removed: [{ agentName: "nova", chatId: "chat-stale" }],
    });
  });

  it("skips a named agent whose workspace root is absent without failing", () => {
    dataDir = mkdtempSync(join(tmpdir(), "ft-clean-skip-"));
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    const cleanFn = vi.fn(() => ["should-not-run"]);
    const result = cleanAgentWorkspaces({
      agentName: "missing",
      dataDir,
      ttlMs: 0,
      cleanWorkspacesFn: cleanFn,
    });
    expect(cleanFn).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "cleaned", removed: [] });
  });

  it("never mutates on-disk files when the low-level cleaner is the zero-deletion no-op", () => {
    dataDir = mkdtempSync(join(tmpdir(), "ft-clean-zero-"));
    const agentHome = join(dataDir, "workspaces", "nova");
    mkdirSync(agentHome, { recursive: true });
    const marker = join(agentHome, "keep-me.txt");
    writeFileSync(marker, "intact", "utf-8");
    writeRegistry(dataDir, "nova", {});

    // Production path: no cleanWorkspacesFn inject → real no-op cleaner.
    const result = cleanAgentWorkspaces({ dataDir, ttlMs: 0 });
    expect(result).toEqual({ kind: "cleaned", removed: [] });
    expect(readFileSync(marker, "utf-8")).toBe("intact");
    expect(readFileSync(join(dataDir, "sessions", "nova.json"), "utf-8")).toContain('"version":1');
  });
});
