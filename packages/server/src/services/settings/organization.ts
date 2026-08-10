import {
  AGENT_VISIBILITY,
  contextTreeActiveBindingSchema,
  contextTreeBranchSchema,
  isOrgSettingNamespace,
  ORG_SETTINGS_NAMESPACES,
  type OrgContextTreeFeaturesInput,
  type OrgContextTreeStorage,
  type OrgSettingInput,
  type OrgSettingNamespace,
  type OrgSettingOutput,
  type OrgSettingStorage,
} from "@first-tree/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { organizationSettings } from "../../db/schema/organization-settings.js";
import { BadRequestError } from "../../errors.js";
import {
  assertContextReviewerAgentAllowed,
  assertContextTreeBindingTargetAuthorized,
  getRawOrgContextTreeSetting,
  resolveContextReviewerAgentSummary,
  resolveStoredContextTreeProvider,
} from "../context-tree/settings.js";
import { getRawOrgSettingValue, lockOrganizationForSettingsMutation } from "./store.js";

/**
 * Generic organization settings, keyed by `(organizationId, namespace)`.
 * Namespace-specific policy remains in the owning domain.
 */

function assertNamespace(ns: string): asserts ns is OrgSettingNamespace {
  if (!isOrgSettingNamespace(ns)) {
    throw new BadRequestError(`Unknown organization-settings namespace: "${ns}"`);
  }
}

async function fetchStorageRow<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
): Promise<OrgSettingStorage<K> | null> {
  const row = await getRawOrgSettingValue(db, orgId, namespace);
  if (!row) return null;
  const schema = ORG_SETTINGS_NAMESPACES[namespace].storage;
  return schema.parse(row.value) as OrgSettingStorage<K>;
}

function emptyStorage<K extends OrgSettingNamespace>(namespace: K): OrgSettingStorage<K> {
  const schema = ORG_SETTINGS_NAMESPACES[namespace].storage;
  return schema.parse({}) as OrgSettingStorage<K>;
}

function isCompleteContextTreeReplacement(input: OrgSettingInput<"context_tree">): boolean {
  return input.repo !== undefined && input.branch !== undefined;
}

function applyInputDelta<K extends OrgSettingNamespace>(
  namespace: K,
  current: OrgSettingStorage<K>,
  input: OrgSettingInput<K>,
): OrgSettingStorage<K> {
  if (namespace === "context_tree") {
    const cur = current as OrgSettingStorage<"context_tree">;
    const inp = input as OrgSettingInput<"context_tree">;
    const next: OrgSettingStorage<"context_tree"> = {
      provider: inp.provider === undefined ? cur.provider : (inp.provider ?? undefined),
      repo: inp.repo === undefined ? cur.repo : (inp.repo ?? undefined),
      branch: inp.branch === undefined ? cur.branch : (inp.branch ?? "main"),
    };
    return next as OrgSettingStorage<K>;
  }
  if (namespace === "source_repos") {
    const cur = current as OrgSettingStorage<"source_repos">;
    const inp = input as OrgSettingInput<"source_repos">;
    const next: OrgSettingStorage<"source_repos"> = {
      repos: inp.repos === undefined ? cur.repos : inp.repos,
    };
    return next as OrgSettingStorage<K>;
  }
  if (namespace === "context_tree_features") {
    const cur = current as OrgSettingStorage<"context_tree_features">;
    const inp = input as OrgSettingInput<"context_tree_features">;
    const agentUuid = inp.contextReviewer.enabled
      ? inp.contextReviewer.agentUuid
      : (inp.contextReviewer.agentUuid ?? cur.contextReviewer.agentUuid);
    const next: OrgSettingStorage<"context_tree_features"> = {
      contextReviewer: {
        enabled: inp.contextReviewer.enabled,
        agentUuid,
      },
    };
    return next as OrgSettingStorage<K>;
  }
  if (namespace === "github_features") {
    const inp = input as OrgSettingInput<"github_features">;
    const next: OrgSettingStorage<"github_features"> = {
      teamAgent: {
        agentUuid: inp.teamAgent.agentUuid,
      },
    };
    return next as OrgSettingStorage<K>;
  }
  const _exhaustive: never = namespace;
  return _exhaustive;
}

async function resolveOrgVisibleAgentSummary(
  db: Database,
  orgId: string,
  agentUuid: string | null,
): Promise<{ uuid: string; name: string | null; displayName: string } | null> {
  if (!agentUuid) return null;
  const [agent] = await db
    .select({ uuid: agents.uuid, name: agents.name, displayName: agents.displayName })
    .from(agents)
    .where(
      and(
        eq(agents.uuid, agentUuid),
        eq(agents.organizationId, orgId),
        eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION),
        ne(agents.status, "deleted"),
      ),
    )
    .limit(1);
  return agent ?? null;
}

async function toOutput<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
  storage: OrgSettingStorage<K>,
): Promise<OrgSettingOutput<K>> {
  if (namespace === "context_tree") {
    const s = storage as OrgSettingStorage<"context_tree">;
    const out: OrgSettingOutput<"context_tree"> = {
      provider: s.provider,
      repo: s.repo,
      branch: s.branch,
    };
    return out as OrgSettingOutput<K>;
  }
  if (namespace === "source_repos") {
    const s = storage as OrgSettingStorage<"source_repos">;
    const out: OrgSettingOutput<"source_repos"> = { repos: s.repos };
    return out as OrgSettingOutput<K>;
  }
  if (namespace === "context_tree_features") {
    const s = storage as OrgSettingStorage<"context_tree_features">;
    const reviewerAgent = await resolveContextReviewerAgentSummary(db, orgId, s.contextReviewer.agentUuid);
    const out: OrgSettingOutput<"context_tree_features"> = {
      contextReviewer: {
        enabled: s.contextReviewer.enabled,
        agentUuid: reviewerAgent?.uuid ?? null,
        reviewerAgent,
      },
    };
    return out as OrgSettingOutput<K>;
  }
  if (namespace === "github_features") {
    const s = storage as OrgSettingStorage<"github_features">;
    const agent = await resolveOrgVisibleAgentSummary(db, orgId, s.teamAgent.agentUuid);
    const out: OrgSettingOutput<"github_features"> = {
      teamAgent: {
        agentUuid: agent?.uuid ?? null,
        agent,
      },
    };
    return out as OrgSettingOutput<K>;
  }
  const _exhaustive: never = namespace;
  return _exhaustive;
}

export async function getOrgSetting<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
): Promise<OrgSettingOutput<K>> {
  assertNamespace(namespace);
  const storage = (await fetchStorageRow(db, orgId, namespace)) ?? emptyStorage(namespace);
  return toOutput(db, orgId, namespace, storage);
}

export async function putOrgSetting<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
  rawInput: unknown,
  options: {
    updatedBy: string;
    memberId?: string;
  },
): Promise<OrgSettingOutput<K>> {
  assertNamespace(namespace);

  const inputSchema = ORG_SETTINGS_NAMESPACES[namespace].input;
  const input = inputSchema.parse(rawInput) as OrgSettingInput<K>;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);

    let current: OrgSettingStorage<K>;
    if (namespace === "context_tree") {
      const rawCurrent = await getRawOrgContextTreeSetting(txDb, orgId);
      const parsedCurrent = ORG_SETTINGS_NAMESPACES.context_tree.storage.safeParse(rawCurrent);
      const contextTreeInput = input as OrgSettingInput<"context_tree">;
      if (!parsedCurrent.success && !isCompleteContextTreeReplacement(contextTreeInput)) {
        throw parsedCurrent.error;
      }
      current = (parsedCurrent.success ? parsedCurrent.data : emptyStorage("context_tree")) as OrgSettingStorage<K>;
    } else {
      current = (await fetchStorageRow(txDb, orgId, namespace)) ?? emptyStorage(namespace);
    }

    let merged = applyInputDelta(namespace, current, input);
    if (namespace === "context_tree") {
      const contextTreeInput = input as OrgSettingInput<"context_tree">;
      merged = (await resolveStoredContextTreeProvider(
        txDb,
        orgId,
        merged as OrgSettingStorage<"context_tree">,
        contextTreeInput,
      )) as OrgSettingStorage<K>;
      await assertContextTreeBindingTargetAuthorized(txDb, orgId, merged as OrgSettingStorage<"context_tree">);
    }
    if (namespace === "context_tree_features") {
      await assertContextReviewerAgentAllowed(txDb, orgId, input as OrgContextTreeFeaturesInput, options.memberId);
    }

    const storageSchema = ORG_SETTINGS_NAMESPACES[namespace].storage;
    const validated = storageSchema.parse(merged) as OrgSettingStorage<K>;
    if (namespace === "context_tree") {
      const contextTree = validated as OrgContextTreeStorage;
      if (contextTree.repo === undefined) {
        contextTreeBranchSchema.parse(contextTree.branch);
      } else {
        contextTreeActiveBindingSchema.parse(contextTree);
      }
    }

    await tx
      .insert(organizationSettings)
      .values({
        organizationId: orgId,
        namespace,
        value: validated as Record<string, unknown>,
        version: 1,
        updatedBy: options.updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [organizationSettings.organizationId, organizationSettings.namespace],
        set: {
          value: validated as Record<string, unknown>,
          version: sql`${organizationSettings.version} + 1`,
          updatedBy: options.updatedBy,
          updatedAt: new Date(),
        },
      });

    return toOutput(txDb, orgId, namespace, validated);
  });
}

export async function deleteOrgSetting(db: Database, orgId: string, namespace: string): Promise<void> {
  assertNamespace(namespace);
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);
    await tx
      .delete(organizationSettings)
      .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, namespace)));
  });
}
