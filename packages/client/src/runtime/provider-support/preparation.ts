/**
 * Runtime-owned managed-session preparation for provider adapters.
 *
 * Owns the pre-provider admission sequence every normal start/resume shares.
 * Providers keep protocol / MCP / prompt translation and process admission;
 * this module does not spawn providers, create ACK authority, or load
 * provider config caches (callers pass already-resolved payload state).
 */

import type { AgentRuntimeConfig, AgentRuntimeConfigPayload, RuntimeProvider } from "@first-tree/shared";
import { ensureAgentBootstrap } from "../agent-bootstrap.js";
import { buildAgentBriefing } from "../agent-briefing.js";
import type { PredeclaredSourceRepo } from "../bootstrap.js";
import { type ChatContext, fetchChatContext } from "../chat-context.js";
import type { SessionContext } from "../handler.js";
import { type ReconciledTeamSkill, reconcileManagedSkillsForConfig } from "../managed-skills.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../source-repos.js";
import { teamSkillBundleResolverFromSdk } from "../team-skill-bundle-resolver.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../workspace.js";

/**
 * Context Tree coordinates carried into the briefing and the stable workspace
 * identity. Grouped because callers always supply the three values together.
 */
export type ContextTreeCoordinates = {
  path: string | null;
  repoUrl: string | null;
  branch: string | null;
};

export type PrepareManagedSessionParams = {
  sessionCtx: SessionContext;
  /** Absolute agent-home root passed to {@link acquireAgentHome}. */
  workspaceRoot: string;
  runtimeProvider: RuntimeProvider;
  /**
   * Live agent runtime config, or `null` when the caller had no config cache.
   * Supplies the Team Skill snapshot to the reconciler.
   */
  runtimeConfig: AgentRuntimeConfig | null;
  /** Effective payload — the caller's provider-specific default when unresolved. */
  payload: AgentRuntimeConfigPayload;
  /**
   * `false` when {@link payload} is a provider default rather than a resolved
   * config. Gates the authoritative workspace-manifest write so a fallback
   * empty repo set is never published as truth.
   */
  payloadResolved: boolean;
  contextTree: ContextTreeCoordinates;
  /**
   * Optional provider-owned work after Managed Skills settle and before the
   * shared briefing / bootstrap / init-complete sentinel. Used today only by
   * Codex app-server landing-campaign workspace-only env setup so that failure
   * still leaves no sentinel and no provider admission.
   */
  beforeBriefing?: (args: {
    workspace: string;
    chatContext: ChatContext | undefined;
    sourceRepos: readonly PredeclaredSourceRepo[];
    teamSkills: readonly ReconciledTeamSkill[];
  }) => void | Promise<void>;
};

export type PreparedManagedSession = {
  workspace: string;
  /**
   * Raw chat context, or `undefined` when the fetch failed or returned
   * nothing. Deliberately unrendered: per-chat context belongs to the caller's
   * provider/session prompt path, never to the shared agent-level briefing.
   */
  chatContext: ChatContext | undefined;
  /** Shared agent-level briefing already written to `<workspace>/AGENTS.md`. */
  briefing: string;
  sourceRepos: readonly PredeclaredSourceRepo[];
  /** Successful current-provider rows from the reconcile that gated this start. */
  teamSkills: readonly ReconciledTeamSkill[];
  /** Team Resource fence version from the reconcile that gated this start. */
  resourceConfigVersion: number;
};

export type ProjectManagedWorkspaceParams = {
  sessionCtx: SessionContext;
  /** Already-acquired agent home (no re-acquire). */
  workspace: string;
  runtimeProvider: RuntimeProvider;
  runtimeConfig: AgentRuntimeConfig | null;
  payload: AgentRuntimeConfigPayload;
  payloadResolved: boolean;
  contextTree: ContextTreeCoordinates;
  /**
   * Required: whether to write the init-complete sentinel after bootstrap.
   * Full admission passes true; mid-session refresh paths that historically
   * skipped the sentinel must pass false explicitly (no default footgun).
   */
  markInitComplete: boolean;
  /**
   * Optional provider-owned checkpoint after Managed Skills settle and before
   * briefing / bootstrap / sentinel. Used for lifecycle fences and landing
   * sandbox env setup so cancellation/failure leaves no sentinel.
   */
  beforeBriefing?: (args: {
    workspace: string;
    sourceRepos: readonly PredeclaredSourceRepo[];
    teamSkills: readonly ReconciledTeamSkill[];
  }) => void | Promise<void>;
};

export type ProjectedManagedWorkspace = {
  briefing: string;
  sourceRepos: readonly PredeclaredSourceRepo[];
  teamSkills: readonly ReconciledTeamSkill[];
  /** Team Resource fence version from the reconcile that produced this projection. */
  resourceConfigVersion: number;
};

/**
 * Best-effort chat-context fetch. A failure degrades to no context with a log
 * rather than blocking the session: chat context enriches a prompt, it is not
 * an admission requirement.
 */
export async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
  try {
    return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
  } catch (err) {
    sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Reconcile Managed Skills, build the shared briefing, run agent bootstrap, and
 * optionally mark init-complete — without acquiring a home or fetching chat
 * context. Used by mid-session projection refresh paths that are not a full
 * start/resume admission.
 */
export async function projectManagedWorkspace(
  params: ProjectManagedWorkspaceParams,
): Promise<ProjectedManagedWorkspace> {
  const {
    sessionCtx,
    workspace,
    runtimeProvider,
    runtimeConfig,
    payload,
    payloadResolved,
    contextTree,
    markInitComplete,
    beforeBriefing,
  } = params;

  const sourceRepos = declaredSourceRepos(workspace, payload);

  const { teamSkills, resourceConfigVersion } = await reconcileManagedSkillsForConfig(
    workspace,
    runtimeProvider,
    runtimeConfig,
    sessionCtx.log,
    teamSkillBundleResolverFromSdk(sessionCtx.sdk),
  );

  if (beforeBriefing) {
    await beforeBriefing({ workspace, sourceRepos, teamSkills });
  }

  const briefing = buildAgentBriefing({
    identity: sessionCtx.agent,
    payload,
    workspacePath: workspace,
    sourceRepos,
    contextTreePath: contextTree.path,
    contextTreeRepoUrl: contextTree.repoUrl,
    contextTreeBranch: contextTree.branch,
    teamSkills,
  });

  ensureAgentBootstrap({
    workspace,
    sessionCtx,
    contextTreePath: contextTree.path,
    briefing,
    currentSourceRepoNames: currentSourceRepoNamesFromPayload(payload, payloadResolved),
  });
  if (markInitComplete) {
    markWorkspaceInitComplete(workspace);
  }

  return { briefing, sourceRepos, teamSkills, resourceConfigVersion };
}

/**
 * Run the provider-neutral managed-session preparation that every normal
 * start/resume shares, in the order the runtime contract requires:
 *
 * 1. acquire the per-agent home;
 * 2. best-effort raw chat context (degrades to none on failure);
 * 3. declare the payload's source repos;
 * 4. settle Managed Skills — this gates provider admission, so a reconcile
 *    that cannot prove discovery safe throws here and leaves the delivery as
 *    unacked recovery debt;
 * 5. optional provider-owned `beforeBriefing` work (e.g. landing sandbox env);
 * 6. build the briefing from *that same* reconcile result;
 * 7. run the shared agent bootstrap;
 * 8. mark the workspace init-complete.
 *
 * Preparation failure remains pre-provider: no provider process/session is
 * opened here, and no new ACK authority is created.
 */
export async function prepareManagedSession(params: PrepareManagedSessionParams): Promise<PreparedManagedSession> {
  const {
    sessionCtx,
    workspaceRoot,
    runtimeProvider,
    runtimeConfig,
    payload,
    payloadResolved,
    contextTree,
    beforeBriefing,
  } = params;

  const workspace = acquireAgentHome(workspaceRoot);
  const chatContext = await fetchChatContextOrLog(sessionCtx);

  const projected = await projectManagedWorkspace({
    sessionCtx,
    workspace,
    runtimeProvider,
    runtimeConfig,
    payload,
    payloadResolved,
    contextTree,
    markInitComplete: true,
    beforeBriefing: beforeBriefing
      ? async (args) => {
          await beforeBriefing({ ...args, chatContext });
        }
      : undefined,
  });

  return {
    workspace,
    chatContext,
    briefing: projected.briefing,
    sourceRepos: projected.sourceRepos,
    teamSkills: projected.teamSkills,
    resourceConfigVersion: projected.resourceConfigVersion,
  };
}

export type { AgentBootstrapParams } from "../agent-bootstrap.js";
// Lower-level Runtime-owned preparation symbols for hot-switch / legacy paths
// that are not a full admission. Re-export owner bindings so identity is
// preserved (no façade wrappers).
export { ensureAgentBootstrap } from "../agent-bootstrap.js";
export type { BuildAgentBriefingOptions } from "../agent-briefing.js";
export { buildAgentBriefing } from "../agent-briefing.js";
export type { ChatContext } from "../chat-context.js";
export { fetchChatContext } from "../chat-context.js";
export type { ReconciledTeamSkill, ReconcileManagedSkillsResult } from "../managed-skills.js";
export {
  isManagedSkillsUnsafeDiscoveryError,
  reconcileManagedSkills,
  reconcileManagedSkillsForConfig,
} from "../managed-skills.js";
export { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../source-repos.js";
export { teamSkillBundleResolverFromSdk } from "../team-skill-bundle-resolver.js";
export { acquireAgentHome, markWorkspaceInitComplete } from "../workspace.js";
