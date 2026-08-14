import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrapWorkspace, deepEqualIdentity, IDENTITY_JSON_REL, writeAgentBriefing } from "./bootstrap.js";
import type { ContextSourceKind } from "./context-source.js";
import type { SessionContext } from "./handler.js";
import { INIT_COMPLETE_SENTINEL_REL } from "./workspace.js";
import {
  CONTEXT_TREE_DIRNAME,
  ensureWorkspaceManifest,
  LOCAL_CONTEXT_DIRNAME,
  type WorkspaceTreeName,
  workspaceHasRemoteLatch,
} from "./workspace-manifest.js";
import { applyPendingMigrations } from "./workspace-migrations.js";

export type AgentBootstrapParams = {
  workspace: string;
  sessionCtx: SessionContext;
  /** Stable AgentSlot `config.name`. Never inferred from displayName or path. */
  agentName: string;
  contextTreePath: string | null;
  contextSourceKind?: ContextSourceKind;
  /**
   * Pre-rendered shared briefing. Built by {@link buildAgentBriefing}
   * and written to `<workspace>/AGENTS.md` on every start/resume (CLAUDE.md is
   * symlinked to it). The latest agent config payload and source-repo
   * declaration flow through this parameter, so callers recompute it before
   * every call. Per-chat Current Chat Context is injected by provider/session
   * prompt paths and must not be written into this shared file.
   */
  briefing: string;
  /**
   * Authoritative source-repo `localPath` set from the live, resolved agent
   * config payload (`currentSourceRepoNamesFromPayload`). `null` when the
   * caller could not resolve a payload (cache miss, default-payload
   * fallback). Gates the workspace-manifest write and is threaded into
   * `applyPendingMigrations` so config-dependent migrations can defer
   * instead of acting on an empty fallback.
   */
  currentSourceRepoNames: ReadonlySet<string> | null;
};

function inferredContextSourceKind(_path: string | null, kind?: ContextSourceKind): ContextSourceKind {
  if (kind) return kind;
  return "none";
}

function manifestTreeName(kind: ContextSourceKind): WorkspaceTreeName | null {
  if (kind === "remote") return CONTEXT_TREE_DIRNAME;
  if (kind === "local") return LOCAL_CONTEXT_DIRNAME;
  return null;
}

/**
 * Hash-check the existing identity.json against current agent metadata and
 * rewrite the stable `.first-tree-workspace/` section only when something
 * changed. Runs OUT
 * of the sentinel gate so agent rename / inboxId / metadata edits still
 * propagate after first bootstrap (proposal R5).
 *
 * The unified briefing is rewritten by the caller via {@link
 * writeAgentBriefing} on every start/resume regardless of this check —
 * identity drift only forces the heavier `.first-tree-workspace/` refresh.
 */
function ensureStableIdentity(
  workspace: string,
  sessionCtx: SessionContext,
  agentName: string,
  contextTreePath: string | null,
  contextSourceKind: ContextSourceKind,
): void {
  const identityPath = join(workspace, IDENTITY_JSON_REL);
  const desired = {
    agentId: sessionCtx.agent.agentId,
    agentName,
    displayName: sessionCtx.agent.displayName,
    type: sessionCtx.agent.type,
    delegateMention: sessionCtx.agent.delegateMention,
    metadata: sessionCtx.agent.metadata,
    serverUrl: sessionCtx.sdk.serverUrl,
    contextTreePath,
    contextSourceKind,
  };
  try {
    const stat = lstatSync(identityPath);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      const current = JSON.parse(readFileSync(identityPath, "utf-8"));
      if (deepEqualIdentity(current, desired)) return;
    }
  } catch {
    // Missing, unreadable, or corrupt JSON — rewrite via bootstrapWorkspace.
  }
  // Mismatch (or missing / corrupt) — re-run the stable bootstrap so the
  // boundary marker and identity.json line up with the current agent
  // metadata. Cheap relative to integrate / git.
  bootstrapWorkspace({
    workspacePath: workspace,
    identity: sessionCtx.agent,
    agentName,
    contextTreePath,
    contextSourceKind,
    serverUrl: sessionCtx.sdk.serverUrl,
  });
}

/**
 * Run the agent-home bootstrap that every handler shares: stable
 * `.first-tree-workspace/` layout and unified briefing rewrite (AGENTS.md +
 * CLAUDE.md symlink). Managed Skill projection is deliberately separate:
 * every handler awaits `reconcileManagedSkills` before it builds the briefing
 * and starts/resumes its provider, so Skill drift is keyed by source revision
 * plus installed digest rather than this bootstrap's sentinel or CLI version.
 *
 * The shared briefing is **always rewritten** on every call, irrespective of
 * drift, so source-repo declarations and current payload prompt.append changes
 * surface promptly for the same agent home. Per-chat context is intentionally
 * outside this file.
 */
export function ensureAgentBootstrap(params: AgentBootstrapParams): void {
  const { workspace, sessionCtx, agentName, contextTreePath, briefing, currentSourceRepoNames } = params;
  if (typeof agentName !== "string" || agentName.length === 0) {
    throw new Error(
      "agent bootstrap requires AgentSlot config.name; refusing to infer agentName from displayName or workspace path",
    );
  }
  const contextSourceKind = inferredContextSourceKind(contextTreePath, params.contextSourceKind);

  applyPendingMigrations(workspace, sessionCtx.log, { currentSourceRepoNames });

  if (contextSourceKind === "local" && workspaceHasRemoteLatch(workspace)) {
    return;
  }

  const treeName = manifestTreeName(contextSourceKind);
  if (treeName !== null && currentSourceRepoNames !== null) {
    ensureWorkspaceManifest(workspace, [...currentSourceRepoNames], sessionCtx.log, treeName, true);
  }

  let sentinelPresent = false;
  try {
    const sentinel = lstatSync(join(workspace, INIT_COMPLETE_SENTINEL_REL));
    sentinelPresent = sentinel.isFile() && !sentinel.isSymbolicLink();
  } catch {
    sentinelPresent = false;
  }
  if (sentinelPresent) {
    ensureStableIdentity(workspace, sessionCtx, agentName, contextTreePath, contextSourceKind);
    writeAgentBriefing(workspace, briefing);
    return;
  }

  bootstrapWorkspace({
    workspacePath: workspace,
    identity: sessionCtx.agent,
    agentName,
    contextTreePath,
    contextSourceKind,
    serverUrl: sessionCtx.sdk.serverUrl,
  });
  writeAgentBriefing(workspace, briefing);
}
