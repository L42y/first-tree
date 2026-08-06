import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultDataDir } from "@first-tree/shared/config";
import { SessionRegistry } from "./session-registry.js";
import { cleanWorkspaces, DEFAULT_WORKSPACE_TTL_MS } from "./workspace.js";

export type CleanAgentWorkspacesOptions = {
  /** When set, clean only this agent home. When omitted, enumerate every agent under workspaces/. */
  agentName?: string;
  /** TTL forwarded to the low-level cleaner (currently a no-op). */
  ttlMs: number;
  /**
   * Override the Client data directory. Production callers omit this and use
   * `defaultDataDir()`; tests inject a temp root.
   */
  dataDir?: string;
  /**
   * Test seam for the low-level cleaner. Production uses {@link cleanWorkspaces}.
   * Kept minimal so orchestration (paths, registry, active-set) stays owned here.
   */
  cleanWorkspacesFn?: (workspaceRoot: string, activeChatIds: Set<string>, ttlMs: number) => string[];
};

export type CleanedWorkspaceEntry = {
  agentName: string;
  chatId: string;
};

export type CleanAgentWorkspacesResult =
  | { kind: "missing-root" }
  | { kind: "cleaned"; removed: CleanedWorkspaceEntry[] };

/**
 * High-level agent-workspace maintenance for the CLI `agent workspace clean`
 * command.
 *
 * Owns `<dataDir>/workspaces` / `<dataDir>/sessions/<agent>.json` layout,
 * agent enumeration, SessionRegistry reads, active/evicted selection, and the
 * low-level {@link cleanWorkspaces} call. The CLI command layer only parses
 * flags and prints the returned structure.
 *
 * Behavior is intentionally unchanged from the prior CLI orchestration:
 * {@link cleanWorkspaces} remains a deprecated zero-deletion no-op, so this
 * never auto-deletes agent homes, clones, worktrees, or legacy chat dirs.
 */
export function cleanAgentWorkspaces(options: CleanAgentWorkspacesOptions): CleanAgentWorkspacesResult {
  const dataDir = options.dataDir ?? defaultDataDir();
  const ttlMs = options.ttlMs;
  const cleanFn = options.cleanWorkspacesFn ?? cleanWorkspaces;
  const workspacesDir = join(dataDir, "workspaces");

  if (!existsSync(workspacesDir)) {
    return { kind: "missing-root" };
  }

  const agentNames = options.agentName ? [options.agentName] : readdirSync(workspacesDir);
  const removed: CleanedWorkspaceEntry[] = [];

  for (const name of agentNames) {
    const agentWorkspaceRoot = join(workspacesDir, name);
    if (!existsSync(agentWorkspaceRoot)) continue;

    const registryPath = join(dataDir, "sessions", `${name}.json`);
    const registry = new SessionRegistry(registryPath);
    const persisted = registry.load();
    const activeChatIds = new Set<string>();
    for (const [chatId, data] of persisted) {
      if (data.status !== "evicted") {
        activeChatIds.add(chatId);
      }
    }

    const cleaned = cleanFn(agentWorkspaceRoot, activeChatIds, ttlMs);
    for (const chatId of cleaned) {
      removed.push({ agentName: name, chatId });
    }
  }

  return { kind: "cleaned", removed };
}

export { DEFAULT_WORKSPACE_TTL_MS };
