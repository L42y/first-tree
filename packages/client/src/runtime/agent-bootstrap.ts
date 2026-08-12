import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextTreeBindingStatus } from "./bootstrap.js";
import { bootstrapWorkspace, deepEqualIdentity, IDENTITY_JSON_REL, writeAgentBriefing } from "./bootstrap.js";
import type { SessionContext } from "./handler.js";
import { INIT_COMPLETE_SENTINEL_REL } from "./workspace.js";
import { ensureWorkspaceManifest, retireWorkspaceManifest } from "./workspace-manifest.js";
import { applyPendingMigrations } from "./workspace-migrations.js";

export type AgentBootstrapParams = {
  workspace: string;
  sessionCtx: SessionContext;
  contextTreePath: string | null;
  /**
   * Tri-state binding status from `resolveAgentContextTreeBinding`. Only
   * `"explicitly-unbound"` retires a stale runtime-generated manifest (the
   * server affirmatively removed the binding); `"unresolved"` keeps any
   * existing manifest as last-known-good. Optional for legacy callers: when
   * omitted it is derived from `contextTreePath` (path ⇒ `bound`, no path ⇒
   * `unresolved`), which never retires — matching the pre-tri-state
   * behaviour. Production callers always pass the resolved status.
   */
  contextTreeBindingStatus?: ContextTreeBindingStatus;
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
function ensureStableIdentity(workspace: string, sessionCtx: SessionContext, contextTreePath: string | null): void {
  const identityPath = join(workspace, IDENTITY_JSON_REL);
  const desired = {
    agentId: sessionCtx.agent.agentId,
    displayName: sessionCtx.agent.displayName,
    type: sessionCtx.agent.type,
    delegateMention: sessionCtx.agent.delegateMention,
    metadata: sessionCtx.agent.metadata,
    serverUrl: sessionCtx.sdk.serverUrl,
    contextTreePath,
  };
  if (existsSync(identityPath)) {
    try {
      const current = JSON.parse(readFileSync(identityPath, "utf-8"));
      if (deepEqualIdentity(current, desired)) return;
    } catch {
      // Corrupt JSON — fall through to rewrite via bootstrapWorkspace.
    }
  }
  // Mismatch (or missing / corrupt) — re-run the stable bootstrap so the
  // boundary marker and identity.json line up with the current agent
  // metadata. Cheap relative to integrate / git.
  bootstrapWorkspace({
    workspacePath: workspace,
    identity: sessionCtx.agent,
    contextTreePath,
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
  const { workspace, sessionCtx, contextTreePath, briefing, currentSourceRepoNames } = params;
  const bindingStatus = params.contextTreeBindingStatus ?? (contextTreePath !== null ? "bound" : "unresolved");

  // One-shot workspace migrations: sweep legacy directory-structure residue
  // (UUID-named per-chat snapshots, the legacy `WHITEPAPER.md` symlink) the
  // moment we re-attach to an old workspace. Each migration runs at most
  // once per workspace — the applier persists its own marker file at
  // `.agent/migrations-applied.json` and skips already-applied ids on
  // subsequent calls. Cheap noop in the steady state.
  //
  // `currentSourceRepoNames` carries the live, resolved source-repo
  // localPaths through to the per-migration context so config-dependent
  // migrations can defer on an unresolved payload (cache miss).
  applyPendingMigrations(workspace, sessionCtx.log, { currentSourceRepoNames });

  // Make this a valid W1 workspace for the shipped First Tree skills: write
  // `<workspace>/.first-tree/workspace.json` naming the tree + bound
  // sources. The tree directory itself (`<workspace>/context-tree`) is
  // agent-managed — the agent clones it on first use per its briefing
  // protocol; the manifest may legitimately name a not-yet-materialised
  // tree. Runs every session (cheap + idempotent) so the manifest tracks
  // source-repo changes. Gated on BOTH a resolved tree binding and a resolved
  // source set — a null source set (cache miss) would write a manifest that
  // falsely claims zero sources, which `first-tree-seed`'s self-check reads.
  //
  // An explicit unbind (`repo: null` from the server) instead RETIRES a stale
  // manifest left by a previously bound session, restoring the "unbound = no
  // manifest" contract. An unresolved binding (fetch failure / invalid
  // payload) keeps the last-known-good manifest untouched. This gate sits
  // before the sentinel fast-path check, so one retirement point covers both
  // paths.
  if (bindingStatus === "explicitly-unbound") {
    retireWorkspaceManifest(workspace, sessionCtx.log);
  } else if (contextTreePath !== null && currentSourceRepoNames !== null) {
    ensureWorkspaceManifest(workspace, [...currentSourceRepoNames], sessionCtx.log);
  }

  const sentinelPresent = existsSync(join(workspace, INIT_COMPLETE_SENTINEL_REL));
  if (sentinelPresent) {
    ensureStableIdentity(workspace, sessionCtx, contextTreePath);
    writeAgentBriefing(workspace, briefing);
    return;
  }

  bootstrapWorkspace({
    workspacePath: workspace,
    identity: sessionCtx.agent,
    contextTreePath,
    serverUrl: sessionCtx.sdk.serverUrl,
  });
  writeAgentBriefing(workspace, briefing);
}
