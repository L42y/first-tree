import {
  AGENT_VISIBILITY,
  type ContextTreeActiveBinding,
  type ContextTreeProvider,
  type ContextTreeSettingState,
  canonicalGitRepoIdentity,
  classifyContextTreeSetting,
  contextTreeActiveBindingSchema,
  contextTreeBranchSchema,
  ORG_SETTINGS_NAMESPACES,
  type OrgContextTreeFeaturesInput,
  type OrgSettingInput,
  type OrgSettingStorage,
  resolveContextTreeProvider,
  resolveGitLabRepositoryWebIdentity,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { githubAppInstallations } from "../../db/schema/github-app-installations.js";
import { gitlabConnections } from "../../db/schema/gitlab-connections.js";
import { members } from "../../db/schema/members.js";
import { organizationSettings } from "../../db/schema/organization-settings.js";
import { organizations } from "../../db/schema/organizations.js";
import { BadRequestError, ConflictError, ForbiddenError } from "../../errors.js";
import { getRawOrgSettingValue, lockOrganizationForSettingsMutation } from "../settings/store.js";

export async function getRawOrgContextTreeSetting(db: Database, orgId: string): Promise<unknown> {
  const row = await getRawOrgSettingValue(db, orgId, "context_tree");
  return row ? row.value : { branch: "main" };
}

/**
 * Read a runtime-safe Context Tree binding for server-internal consumers.
 *
 * The admin-only `/context_tree/raw` settings read preserves loose historical
 * values for repair. Runtime consumers must fail closed: an incomplete or
 * invalid historical row is not an active binding.
 */
export async function getOrgContextTreeBinding(db: Database, orgId: string): Promise<ContextTreeActiveBinding | null> {
  const state = await getOrgContextTreeSettingState(db, orgId);
  return state.kind === "bound" ? state.binding : null;
}

/**
 * Read the live Context Tree binding and raw Reviewer assignment in one
 * database statement. Server-internal review mutations use this tuple so they
 * never combine a binding from one settings snapshot with an assignment from
 * another. Member- or Agent-readable surfaces must use the Team-safe
 * projection below.
 */
export async function getOrgContextReviewRuntime(db: Database, orgId: string): Promise<OrgContextReviewRuntime> {
  const rows = await db
    .select({
      namespace: organizationSettings.namespace,
      value: organizationSettings.value,
      gitlabConnectionId: gitlabConnections.id,
      gitlabInstanceOrigin: gitlabConnections.instanceOrigin,
      gitlabEndpointFirstSeenAt: gitlabConnections.endpointFirstSeenAt,
      gitlabLastValidInboundAt: gitlabConnections.lastValidInboundAt,
    })
    .from(organizations)
    .leftJoin(
      organizationSettings,
      and(
        eq(organizationSettings.organizationId, organizations.id),
        inArray(organizationSettings.namespace, ["context_tree", "context_tree_features"]),
      ),
    )
    .leftJoin(gitlabConnections, eq(gitlabConnections.organizationId, organizations.id))
    .where(eq(organizations.id, orgId));
  const values = new Map(rows.flatMap((row) => (row.namespace === null ? [] : [[row.namespace, row.value] as const])));
  const connectionRow = rows.find((row) => row.gitlabConnectionId !== null);
  const gitlabConnection =
    connectionRow?.gitlabConnectionId && connectionRow.gitlabInstanceOrigin
      ? {
          id: connectionRow.gitlabConnectionId,
          instanceOrigin: connectionRow.gitlabInstanceOrigin,
          endpointFirstSeenAt: connectionRow.gitlabEndpointFirstSeenAt,
          lastValidInboundAt: connectionRow.gitlabLastValidInboundAt,
        }
      : null;
  const tree = classifyContextTreeSetting(values.has("context_tree") ? values.get("context_tree") : {});
  const features = ORG_SETTINGS_NAMESPACES.context_tree_features.storage.parse(
    values.get("context_tree_features") ?? {},
  );
  const repo = tree.kind === "bound" ? tree.binding.repo : null;
  const resolution =
    tree.kind === "bound"
      ? resolveContextTreeProvider({
          repo,
          declaredProvider: tree.binding.provider,
          gitlabInstanceOrigin: gitlabConnection?.instanceOrigin,
        })
      : resolveContextTreeProvider({ repo: null });
  const gitlabIdentity =
    resolution.provider === "gitlab" && gitlabConnection
      ? resolveGitLabRepositoryWebIdentity(repo, gitlabConnection.instanceOrigin)
      : null;
  const providerMatchesRepository =
    tree.kind !== "invalid" &&
    resolution.provider !== null &&
    resolution.declaredProviderMatches &&
    (resolution.provider !== "gitlab" || gitlabIdentity?.originMatchesConnection === true);

  return {
    bindingState: tree.kind,
    provider: resolution.provider,
    repo,
    branch: tree.kind === "bound" ? tree.binding.branch : tree.kind === "unbound" ? tree.branch : null,
    providerSource: resolution.source,
    providerMatchesRepository,
    gitlabConnection: gitlabConnection
      ? {
          id: gitlabConnection.id,
          instanceOrigin: gitlabConnection.instanceOrigin,
          endpointSeen: gitlabConnection.endpointFirstSeenAt !== null,
          lastValidInboundAt: gitlabConnection.lastValidInboundAt,
        }
      : null,
    contextReviewer: {
      enabled: features.contextReviewer.enabled,
      agentUuid: features.contextReviewer.agentUuid,
      managerHumanAgentId: null,
      managerActiveAdmin: false,
    },
  };
}

/**
 * Apply the same Team-safe Reviewer identity projection as `getOrgSetting`.
 * Invalid historical private, deleted, or foreign selections remain stored
 * for admin replacement without exposing their opaque UUID to Team runtimes.
 */
export async function getTeamSafeOrgContextReviewRuntime(
  db: Database,
  orgId: string,
): Promise<OrgContextReviewRuntime> {
  const runtime = await getOrgContextReviewRuntime(db, orgId);
  const reviewerAgent = await resolveContextReviewerAgentSummary(db, orgId, runtime.contextReviewer.agentUuid);
  return {
    ...runtime,
    contextReviewer: {
      enabled: runtime.contextReviewer.enabled,
      agentUuid: reviewerAgent?.uuid ?? null,
      managerHumanAgentId: reviewerAgent?.managerHumanAgentId ?? null,
      managerActiveAdmin: reviewerAgent?.managerActiveAdmin ?? false,
    },
  };
}

export type OrgContextReviewRuntime = {
  bindingState: "bound" | "unbound" | "invalid";
  provider: ContextTreeProvider | null;
  repo: string | null;
  branch: string | null;
  providerSource: "declared" | "github_host" | "gitlab_connection" | "unknown";
  providerMatchesRepository: boolean;
  gitlabConnection: {
    id: string;
    instanceOrigin: string;
    endpointSeen: boolean;
    lastValidInboundAt: Date | null;
  } | null;
  contextReviewer: {
    enabled: boolean;
    agentUuid: string | null;
    managerHumanAgentId: string | null;
    managerActiveAdmin: boolean;
  };
};

/**
 * Project the joined Context Review runtime into the only member-safe Context
 * Tree setting shape. Persisted providerless bindings gain a provider only
 * when the current runtime can resolve it against the repository authority.
 */
export function projectOrgContextTreeSettingState(runtime: OrgContextReviewRuntime): ContextTreeSettingState {
  if (runtime.bindingState === "invalid") return { kind: "invalid" };

  if (runtime.bindingState === "unbound") {
    const state = classifyContextTreeSetting({ branch: runtime.branch });
    return state.kind === "unbound" ? state : { kind: "invalid" };
  }

  const state = classifyContextTreeSetting({
    repo: runtime.repo,
    branch: runtime.branch,
    ...(runtime.provider && runtime.providerMatchesRepository ? { provider: runtime.provider } : {}),
  });
  return state.kind === "bound" ? state : { kind: "invalid" };
}

function isSameOrgContextTreeBindingRuntime(
  current: OrgContextReviewRuntime,
  expected: OrgContextReviewRuntime,
): boolean {
  return (
    current.bindingState === expected.bindingState &&
    current.provider === expected.provider &&
    current.repo === expected.repo &&
    current.branch === expected.branch &&
    current.providerMatchesRepository === expected.providerMatchesRepository &&
    current.gitlabConnection?.id === expected.gitlabConnection?.id &&
    current.gitlabConnection?.instanceOrigin === expected.gitlabConnection?.instanceOrigin
  );
}

/**
 * Recheck only the Context Tree binding and provider route used by a snapshot.
 * Reviewer assignment and enablement are independent and must not invalidate
 * an in-flight Tree read.
 */
export async function isOrgContextTreeBindingRuntimeCurrent(
  db: Database,
  orgId: string,
  expected: OrgContextReviewRuntime,
): Promise<boolean> {
  const current = await getOrgContextReviewRuntime(db, orgId);
  return isSameOrgContextTreeBindingRuntime(current, expected);
}

/**
 * Recheck the complete review mutation tuple, including the selected Reviewer.
 */
export async function isOrgContextReviewRuntimeCurrent(
  db: Database,
  orgId: string,
  expected: OrgContextReviewRuntime,
): Promise<boolean> {
  const current = await getOrgContextReviewRuntime(db, orgId);
  return (
    isSameOrgContextTreeBindingRuntime(current, expected) &&
    current.contextReviewer.enabled === expected.contextReviewer.enabled &&
    current.contextReviewer.agentUuid === expected.contextReviewer.agentUuid
  );
}

/**
 * Classify the storage-compatible binding without resolving a provider.
 * Member-readable API surfaces must project `OrgContextReviewRuntime` through
 * `projectOrgContextTreeSettingState` instead.
 */
export async function getOrgContextTreeSettingState(db: Database, orgId: string): Promise<ContextTreeSettingState> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, "context_tree")))
    .limit(1);
  return classifyContextTreeSetting(row ? row.value : {});
}

/**
 * Find another organization already bound to `repoUrl`, if any.
 *
 * A Context Tree repo belongs to exactly one team. Provisioning derives a repo
 * name and adopts an existing repo when GitHub reports the name is taken, so
 * "the name matches" is only ever a guess about ownership — this is the fact.
 * Without it, two teams whose names derive the same repo name end up sharing
 * one tree, and the second team silently reads and writes the first team's
 * decisions.
 *
 * Comparison is on repository identity, never on URL text. The binding contract
 * accepts HTTPS, `ssh://`, and scp-like SSH spellings with an optional `.git`,
 * so a team bound through one transport must still be found when the lookup
 * arrives through another — a text comparison would report no conflict and hand
 * over a repository that is already someone's tree.
 *
 * Each side is resolved through its own team's GitLab connection, so an SSH
 * reference and an HTTPS reference to one self-managed repository reduce to the
 * same web identity. Resolution happens in application code rather than SQL
 * because the identity rule is the shared cross-package one; the scan is
 * bounded by teams that have a tree bound at all, and this runs once per write.
 */
export async function findOrgBoundToContextTreeRepo(
  db: Database,
  excludeOrgId: string,
  repoUrl: string,
): Promise<string | null> {
  const [callerConnection] = await db
    .select({ instanceOrigin: gitlabConnections.instanceOrigin })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, excludeOrgId))
    .limit(1);
  const target = contextTreeRepoOwnershipIdentity(repoUrl, callerConnection?.instanceOrigin);
  if (!target) return null;

  const rows = await db
    .select({
      organizationId: organizationSettings.organizationId,
      repo: sql<string | null>`${organizationSettings.value}->>'repo'`,
      instanceOrigin: gitlabConnections.instanceOrigin,
    })
    .from(organizationSettings)
    .leftJoin(gitlabConnections, eq(gitlabConnections.organizationId, organizationSettings.organizationId))
    .where(
      and(
        eq(organizationSettings.namespace, "context_tree"),
        ne(organizationSettings.organizationId, excludeOrgId),
        sql`${organizationSettings.value}->>'repo' IS NOT NULL`,
      ),
    );

  return (
    rows.find((row) => contextTreeRepoOwnershipIdentity(row.repo, row.instanceOrigin) === target)?.organizationId ??
    null
  );
}

/**
 * Read the Context Tree binding plus row freshness. Onboarding recovery uses
 * `updatedAt` to distinguish a tree binding created after the user completed
 * the value-first work chat from an older, already-adopted team tree.
 */
export async function getOrgContextTreeWithMeta(
  db: Database,
  orgId: string,
): Promise<{ binding: ContextTreeActiveBinding | null; updatedAt: Date | null }> {
  const [row] = await db
    .select({ value: organizationSettings.value, updatedAt: organizationSettings.updatedAt })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, "context_tree")))
    .limit(1);
  if (!row) return { binding: null, updatedAt: null };
  const state = classifyContextTreeSetting(row.value);
  return { binding: state.kind === "bound" ? state.binding : null, updatedAt: row.updatedAt };
}

/**
 * Persist an initialized Context Tree binding only while the exact unbound
 * branch observed by the caller is still current. Callers can perform external
 * work between observation and finalization, so this conditional write is the
 * authoritative concurrency guard.
 *
 * Every regular settings mutation takes the same organization-row lock. The
 * `setWhere` predicate also protects against a writer that bypasses this
 * service: PostgreSQL returns no row when a concurrent value gains a repo or
 * changes the unbound branch observed by the early route check.
 */
export async function putInitializedOrgContextTreeBinding(
  db: Database,
  orgId: string,
  rawInput: unknown,
  options: {
    updatedBy: string;
    expectedUnboundBranch: string;
  },
): Promise<ContextTreeActiveBinding> {
  const binding = contextTreeActiveBindingSchema.parse(rawInput);
  const expectedUnboundBranch = contextTreeBranchSchema.parse(options.expectedUnboundBranch);
  const value: Record<string, unknown> = {
    provider: binding.provider,
    repo: binding.repo,
    branch: binding.branch,
  };

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);
    const current = await getOrgContextTreeSettingState(txDb, orgId);
    if (current.kind !== "unbound" || current.branch !== expectedUnboundBranch) {
      throw new ConflictError("Context Tree setting changed after tree initialization began");
    }
    await assertContextTreeBindingTargetAuthorized(txDb, orgId, binding);
    const now = new Date();

    const [row] = await tx
      .insert(organizationSettings)
      .values({
        organizationId: orgId,
        namespace: "context_tree",
        value,
        version: 1,
        updatedBy: options.updatedBy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [organizationSettings.organizationId, organizationSettings.namespace],
        set: {
          value,
          version: sql`${organizationSettings.version} + 1`,
          updatedBy: options.updatedBy,
          updatedAt: now,
        },
        setWhere: sql`
          jsonb_typeof(${organizationSettings.value}) = 'object'
          AND NOT (${organizationSettings.value} ? 'repo')
          AND (
            (
              jsonb_typeof(${organizationSettings.value} -> 'branch') = 'string'
              AND ${organizationSettings.value} ->> 'branch' = ${expectedUnboundBranch}
            )
            OR (
              NOT (${organizationSettings.value} ? 'branch')
              AND ${expectedUnboundBranch} = 'main'
            )
          )
        `,
      })
      .returning({ value: organizationSettings.value });

    if (!row) {
      throw new ConflictError("Context Tree setting changed after tree initialization began");
    }
    return contextTreeActiveBindingSchema.parse(row.value);
  });
}

export async function resolveContextReviewerAgentSummary(
  db: Database,
  orgId: string,
  agentUuid: string | null,
): Promise<{
  uuid: string;
  name: string | null;
  displayName: string;
  managerHumanAgentId: string | null;
  managerActiveAdmin: boolean;
} | null> {
  if (!agentUuid) return null;
  const [agent] = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      managerHumanAgentId: members.agentId,
      managerOrganizationId: members.organizationId,
      managerStatus: members.status,
      managerRole: members.role,
    })
    .from(agents)
    .leftJoin(members, eq(members.id, agents.managerId))
    .where(
      and(
        eq(agents.uuid, agentUuid),
        eq(agents.organizationId, orgId),
        eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION),
        ne(agents.status, "deleted"),
      ),
    )
    .limit(1);
  if (!agent) return null;
  return {
    uuid: agent.uuid,
    name: agent.name,
    displayName: agent.displayName,
    managerHumanAgentId: agent.managerHumanAgentId,
    managerActiveAdmin:
      agent.managerOrganizationId === orgId && agent.managerStatus === "active" && agent.managerRole === "admin",
  };
}

export async function assertContextReviewerAgentAllowed(
  db: Database,
  orgId: string,
  input: OrgContextTreeFeaturesInput,
  memberId: string | undefined,
): Promise<void> {
  if (!input.contextReviewer.enabled) return;
  if (!memberId) {
    throw new ForbiddenError("Context Reviewer can only be assigned by an active member of this organization");
  }
  const agentUuid = input.contextReviewer.agentUuid;
  if (!agentUuid) {
    throw new BadRequestError("agentUuid is required when Context Reviewer is enabled");
  }

  const [agent] = await db
    .select({
      uuid: agents.uuid,
      type: agents.type,
      status: agents.status,
      organizationId: agents.organizationId,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(eq(agents.uuid, agentUuid))
    .limit(1);

  if (!agent || agent.organizationId !== orgId || agent.type === "human" || agent.status !== "active") {
    throw new BadRequestError("Context Reviewer agent must be an active non-human agent in this organization");
  }
  const [manager] = await db
    .select({ organizationId: members.organizationId, status: members.status, role: members.role })
    .from(members)
    .where(eq(members.id, agent.managerId))
    .limit(1);
  if (!manager || manager.organizationId !== orgId || manager.status !== "active" || manager.role !== "admin") {
    throw new BadRequestError("Context Reviewer agent must be managed by an active Team Admin");
  }
  const runtime = await getOrgContextReviewRuntime(db, orgId);
  if (
    runtime.bindingState !== "bound" ||
    !runtime.provider ||
    !runtime.providerMatchesRepository ||
    !runtime.repo ||
    !runtime.branch
  ) {
    throw new BadRequestError(
      "Context Reviewer requires a valid Context Tree binding with a resolved GitHub or GitLab provider",
    );
  }
  if (runtime.provider === "gitlab") {
    if (
      !runtime.providerMatchesRepository ||
      !runtime.gitlabConnection ||
      !resolveContextTreeProvider({
        repo: runtime.repo,
        declaredProvider: "gitlab",
        gitlabInstanceOrigin: runtime.gitlabConnection.instanceOrigin,
      }).gitlabConnectionMatches
    ) {
      throw new BadRequestError(
        "Context Reviewer for GitLab requires the current GitLab connection origin to match the Context Tree repository",
      );
    }
    return;
  }
  if (runtime.provider !== "github") {
    throw new BadRequestError("Context Reviewer requires a supported Context Tree provider");
  }
  const [installation] = await db
    .select({ permissions: githubAppInstallations.permissions, suspendedAt: githubAppInstallations.suspendedAt })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.hubOrganizationId, orgId))
    .limit(1);
  if (!installation || installation.suspendedAt || installation.permissions.pull_requests !== "write") {
    throw new BadRequestError(
      "Context Reviewer requires an active GitHub App installation with Pull requests: write permission accepted",
    );
  }
}

export async function resolveStoredContextTreeProvider(
  db: Database,
  orgId: string,
  storage: OrgSettingStorage<"context_tree">,
  input: OrgSettingInput<"context_tree">,
): Promise<OrgSettingStorage<"context_tree">> {
  if (!storage.repo) return { ...storage, provider: undefined };
  if (input.repo === undefined && input.provider === undefined) return storage;

  const [connection] = await db
    .select({ instanceOrigin: gitlabConnections.instanceOrigin })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, orgId))
    .limit(1);
  const directlyResolved = resolveContextTreeProvider({
    repo: storage.repo,
    declaredProvider: input.provider ?? undefined,
    gitlabInstanceOrigin: connection?.instanceOrigin,
  });
  if (directlyResolved.provider) return { ...storage, provider: directlyResolved.provider };

  return { ...storage, provider: undefined };
}

/**
 * Identity two Context Tree bindings are compared on to decide whether they
 * name the same repository.
 *
 * The identity is the repository's web origin and path. Where that origin comes
 * from depends on the reference, because the binding contract accepts HTTPS,
 * `ssh://`, and scp-like SSH spellings:
 *
 * - GitHub states it implicitly — one fixed origin, no port — so every
 *   spelling already agrees under the shared canonical form.
 * - An HTTP(S) reference states it outright, port included, and needs nothing
 *   else. Asking for a connection here would discard the identity of a binding
 *   whose team later deletes its connection, and that binding still owns its
 *   repository.
 * - An SSH or scp-like reference states no origin at all, and its transport
 *   port is never the forge's, so only the owning team's GitLab connection can
 *   supply one.
 *
 * All three land on the same string for one repository, so a team on HTTPS and
 * a team on SSH are seen to hold the same tree. Two self-managed instances on
 * one host stay distinct, because a non-default web port is part of which
 * forge it is.
 *
 * An SSH reference whose team has no connection, or whose host does not match
 * it, has no establishable origin and returns null. That fails open on the safe
 * side: a conflict goes unnoticed rather than a legitimate binding being
 * refused on a guess.
 */
export function contextTreeRepoOwnershipIdentity(
  repo: string | null | undefined,
  gitlabInstanceOrigin: string | null | undefined,
): string | null {
  const identity = canonicalGitRepoIdentity(repo);
  if (!identity || !repo) return null;

  // GitHub has one fixed origin and no port, so every spelling already agrees.
  if (identity.host === "github.com") return identity.canonical;

  // An HTTP(S) reference states its own web origin, port included. Requiring a
  // connection to read it would drop the identity of a binding whose team later
  // deletes its connection — and that binding still owns its repository.
  try {
    const url = new URL(repo.trim());
    if (url.protocol === "https:" || url.protocol === "http:") {
      return `${url.origin.toLowerCase()}/${identity.path}`;
    }
  } catch {
    // Not a URL — scp-like SSH, handled below.
  }

  // SSH and scp-like references carry no web origin, and their transport port
  // is never the forge's, so only the owning team's connection can supply one.
  const web = resolveGitLabRepositoryWebIdentity(repo, gitlabInstanceOrigin);
  return web?.originMatchesConnection ? `${web.origin}/${web.path}` : null;
}

/**
 * Refuse a binding that would point this team at another team's Context Tree.
 *
 * A Context Tree repository backs one team: sharing one merges two teams'
 * decisions, constraints, and ownership into a single tree. This runs on every
 * binding write — Cloud provisioning, manual Settings binding, and the
 * `tree init` callback alike — because the repository is the thing being
 * claimed regardless of which surface names it.
 *
 * Two organizations binding the same repository at the same instant can still
 * both pass this check: the caller holds its own organization row, which does
 * not serialize a different organization's write. That window is left open
 * rather than closed with a lock on the repository identity.
 */
async function assertContextTreeRepoNotHeldByAnotherOrg(
  db: Database,
  orgId: string,
  binding: OrgSettingStorage<"context_tree">,
): Promise<void> {
  if (!binding.repo) return;

  const holder = await findOrgBoundToContextTreeRepo(db, orgId, binding.repo);
  if (holder) {
    throw new ConflictError("That repository is already another team's Context Tree");
  }
}

export async function assertContextTreeBindingTargetAuthorized(
  db: Database,
  orgId: string,
  binding: OrgSettingStorage<"context_tree">,
): Promise<void> {
  await assertContextTreeRepoNotHeldByAnotherOrg(db, orgId, binding);
  if (!binding.provider || !binding.repo) return;
  const resolution = resolveContextTreeProvider({
    repo: binding.repo,
    declaredProvider: binding.provider,
  });
  if (!resolution.declaredProviderMatches) {
    throw new BadRequestError("Context Tree provider does not match the repository origin");
  }
  if (binding.provider !== "gitlab") return;
  const [connection] = await db
    .select({ instanceOrigin: gitlabConnections.instanceOrigin })
    .from(gitlabConnections)
    .where(eq(gitlabConnections.organizationId, orgId))
    .limit(1);
  if (!connection) {
    throw new BadRequestError("GitLab Context Tree repository requires a current GitLab connection");
  }
  const identity = resolveGitLabRepositoryWebIdentity(binding.repo, connection.instanceOrigin);
  if (!identity?.originMatchesConnection) {
    throw new BadRequestError("GitLab Context Tree repository origin must match the current GitLab connection origin");
  }
}
