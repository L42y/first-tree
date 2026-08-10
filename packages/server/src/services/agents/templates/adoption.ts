import { createHash } from "node:crypto";
import {
  AGENT_STATUSES,
  AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES,
  AGENT_TYPES,
  type AgentTemplateComponent,
  type AgentTemplatePayload,
  agentTemplatePayloadSchema,
  type UpdateAgentTemplates,
} from "@first-tree/shared";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { agentConfigs } from "../../../db/schema/agent-configs.js";
import { agentResourceBindings } from "../../../db/schema/agent-resource-bindings.js";
import { agentTemplates } from "../../../db/schema/agent-templates.js";
import { agents } from "../../../db/schema/agents.js";
import { resources } from "../../../db/schema/resources.js";
import { type AppErrorAttrs, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../../errors.js";
import { uuidv7 } from "../../../uuid.js";
import { copyAttachmentForOrganization } from "../../attachment.js";
import type { AttachmentBlobStore } from "../../attachment-blob-store.js";
import { assertMutableAgentIsNotLandingCampaignTrial } from "../../landing-campaigns/guards.js";
import type { Notifier } from "../../notifier.js";
import { assertTeamSkillNameAvailable, lockTeamSkillNames } from "../resources/catalog.js";
import { assertNoRuntimeSwitchInProgress } from "../runtime/switch.js";
import { assertSkillComponentMatchesBundle } from "./catalog.js";

/** Conflict that belongs to Template adoption (not name / version CAS). */
function adoptionConflict(message: string, attrs?: AppErrorAttrs): ConflictError {
  return new ConflictError(message, {
    ...(attrs ?? {}),
    code: AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.ADOPTION_CONFLICT,
  });
}

/**
 * Downstream helpers (Skill name check, Skill bundle verify, attachment
 * quota) may throw ConflictError with no code or an unrelated helper code.
 * This wrapper only wraps adoption helpers, so always keep message/attrs and
 * force the adoption wire code — otherwise New Agent would drop the error
 * into `_root` instead of the Responsibilities section.
 */
function rethrowAsAdoptionConflict(err: unknown): never {
  if (err instanceof ConflictError) {
    if (err.attrs?.code === AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.ADOPTION_CONFLICT) throw err;
    throw new ConflictError(err.message, {
      ...(err.attrs ?? {}),
      code: AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.ADOPTION_CONFLICT,
    });
  }
  throw err;
}

async function withAdoptionConflictCode<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrowAsAdoptionConflict(err);
  }
}

/**
 * Agent Template adoption: turn an Agent's adopted Template set into
 * Team-owned configuration in one bounded, atomic write.
 *
 * Boundaries (frozen design):
 * - First adoption in a Team imports every component as Team-owned
 *   `available` Resources; later adoptions in the same Team reuse whatever
 *   provenance Resources the Team currently keeps — no re-sync, no repair.
 * - Bindings created by adoption carry Template/component provenance so a
 *   later removal deletes exactly those auto-bindings and nothing else.
 * - The write shares the existing `agent_configs.version` optimistic lock
 *   and emits exactly one config-change notification after commit.
 */

type AgentRow = { uuid: string; organizationId: string; type: string };
type ResourceRow = typeof resources.$inferSelect;

export type AdoptAgentTemplatesResult = {
  version: number;
  templateIds: string[];
};

/** Deterministic provenance digest for one imported component. */
function templateComponentDigest(component: AgentTemplateComponent, zipBytes?: Buffer): string {
  const hash = createHash("sha256");
  hash.update("agent-template-component:v1\n");
  hash.update(JSON.stringify(component));
  if (zipBytes) {
    hash.update("\nzip-bytes\n");
    hash.update(zipBytes);
  }
  return hash.digest("hex");
}

function skillBundleIds(components: readonly AgentTemplateComponent[]): string[] {
  return components.flatMap((component) => (component.type === "skill" ? [component.bundle.attachmentId] : []));
}

/**
 * Lock and fully verify an official Template row for adoption: present,
 * currently active, strictly valid payload with at least one component, and
 * every Skill bundle still available to the Publisher Team with a matching
 * projection.
 */
async function lockAndVerifyTemplate(
  db: Database,
  blobStore: AttachmentBlobStore,
  publisherOrgId: string,
  templateId: string,
): Promise<{ id: string; payload: AgentTemplatePayload }> {
  const [row] = await db
    .select({ id: agentTemplates.id, status: agentTemplates.status, payload: agentTemplates.payload })
    .from(agentTemplates)
    .where(eq(agentTemplates.id, templateId))
    .for("update")
    .limit(1);
  if (!row) throw new NotFoundError(`Agent Template "${templateId}" not found`);
  if (row.status !== "active") {
    throw adoptionConflict(`Agent Template "${templateId}" is not active and cannot be adopted`);
  }
  const parsed = agentTemplatePayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    throw adoptionConflict(`Agent Template "${templateId}" is not valid and cannot be adopted`);
  }
  if (parsed.data.components.length === 0) {
    throw adoptionConflict(`Agent Template "${templateId}" has no components and cannot be adopted`);
  }
  for (const component of parsed.data.components) {
    if (component.type !== "skill") continue;
    await withAdoptionConflictCode(() => assertSkillComponentMatchesBundle(db, blobStore, publisherOrgId, component));
  }
  return { id: row.id, payload: parsed.data };
}

/** First-time import of every component into the adopting Team. */
async function importTemplateComponents(
  db: Database,
  organizationId: string,
  templateId: string,
  payload: AgentTemplatePayload,
  actorId: string,
  bundleTargetBySourceId: ReadonlyMap<string, string>,
  digestByComponentKey: ReadonlyMap<string, string>,
): Promise<ResourceRow[]> {
  const created: ResourceRow[] = [];
  for (const component of payload.components) {
    const base = {
      id: uuidv7(),
      organizationId,
      scope: "team" as const,
      ownerAgentId: null,
      name: component.name,
      repoCanonicalKey: null,
      bundleAttachmentId: null,
      defaultEnabled: "available" as const,
      status: "active" as const,
      createdBy: actorId,
      updatedBy: actorId,
      originTemplateId: templateId,
      originComponentKey: component.key,
    };
    if (component.type === "skill") {
      const targetAttachmentId = bundleTargetBySourceId.get(component.bundle.attachmentId);
      const digest = digestByComponentKey.get(`${templateId}:${component.key}`);
      if (!targetAttachmentId || !digest) {
        throw new Error(`Missing copied bundle for source attachment "${component.bundle.attachmentId}"`);
      }
      const [row] = await db
        .insert(resources)
        .values({
          ...base,
          type: "skill",
          bundleAttachmentId: targetAttachmentId,
          payload: component.payload,
          originContentDigest: digest,
        })
        .returning();
      if (!row) throw new Error("Template Skill Resource insert returned no row");
      created.push(row);
      continue;
    }
    const [row] = await db
      .insert(resources)
      .values({
        ...base,
        type: component.type,
        payload: component.payload,
        originContentDigest: templateComponentDigest(component),
      })
      .returning();
    if (!row) throw new Error("Template Resource insert returned no row");
    created.push(row);
  }
  return created;
}

/** Create provenance-carrying include bindings, respecting manual choices. */
async function bindAdoptedResources(
  db: Database,
  agent: AgentRow,
  rows: readonly ResourceRow[],
  actorId: string,
): Promise<void> {
  for (const row of rows) {
    const existing = await db
      .select()
      .from(agentResourceBindings)
      .where(
        and(
          eq(agentResourceBindings.agentId, agent.uuid),
          or(eq(agentResourceBindings.resourceId, row.id), eq(agentResourceBindings.replacesResourceId, row.id)),
        ),
      );
    // A disable, or a replace in either direction, is a deliberate manual
    // choice the adoption must not silently override.
    if (existing.some((binding) => binding.mode === "disable" || binding.mode === "replace")) {
      throw adoptionConflict(
        `Agent "${agent.uuid}" already has a manual choice for Resource "${row.name}"; resolve it before adopting this Template`,
      );
    }
    if (existing.some((binding) => binding.mode === "include" && binding.resourceId === row.id)) continue;
    await db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: agent.organizationId,
      agentId: agent.uuid,
      type: row.type,
      mode: "include",
      resourceId: row.id,
      order: 0,
      originTemplateId: row.originTemplateId,
      originComponentKey: row.originComponentKey,
      createdBy: actorId,
      updatedBy: actorId,
    });
  }
}

/**
 * Small deterministic guard: newly adopted MCP Resources must not collide
 * (case-insensitively) with the Agent's currently effective MCP names. The
 * newly adopted Resources themselves are excluded from the "existing" scan
 * so a manual include of the same Resource cannot report against itself.
 */
async function assertNewMcpNamesAvailable(
  db: Database,
  agent: AgentRow,
  newRows: readonly ResourceRow[],
): Promise<void> {
  const newNames = newRows.flatMap((row) =>
    row.type === "mcp" && typeof (row.payload as { name?: unknown }).name === "string"
      ? [(row.payload as { name: string }).name.toLowerCase()]
      : [],
  );
  if (newNames.length === 0) return;
  if (new Set(newNames).size !== newNames.length) {
    throw adoptionConflict("The adopted Templates provide duplicate MCP server names");
  }
  const newResourceIds = new Set(newRows.map((row) => row.id));
  const bindings = await db
    .select({
      mode: agentResourceBindings.mode,
      resourceId: agentResourceBindings.resourceId,
      replacesResourceId: agentResourceBindings.replacesResourceId,
    })
    .from(agentResourceBindings)
    .where(eq(agentResourceBindings.agentId, agent.uuid));
  const disabled = new Set(bindings.flatMap((b) => (b.mode === "disable" && b.resourceId ? [b.resourceId] : [])));
  const replaced = new Set(
    bindings.flatMap((b) => (b.mode === "replace" && b.replacesResourceId ? [b.replacesResourceId] : [])),
  );
  // Same explicit-enable rule as the effective-resource resolver.
  const explicitlyBound = new Set(
    bindings.flatMap((b) => (b.mode !== "disable" && b.resourceId ? [b.resourceId] : [])),
  );
  const candidates = await db
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, agent.organizationId),
        eq(resources.type, "mcp"),
        inArray(resources.status, ["active", "stale"]),
      ),
    );
  for (const row of candidates) {
    if (newResourceIds.has(row.id)) continue;
    // Mirrors the effective-resource resolver: an explicit include/replace
    // binding always yields an enabled row, while disable/replace only
    // suppress the default recommended row.
    const effective =
      explicitlyBound.has(row.id) ||
      (row.scope === "team" && row.defaultEnabled === "recommended" && !disabled.has(row.id) && !replaced.has(row.id));
    if (!effective) continue;
    const name =
      typeof (row.payload as { name?: unknown }).name === "string"
        ? (row.payload as { name: string }).name.toLowerCase()
        : null;
    if (name && newNames.includes(name)) {
      throw adoptionConflict(`MCP server name "${name}" is already in use by Agent "${agent.uuid}"`);
    }
  }
}

async function adoptTemplatesInTransaction(
  db: Database,
  blobStore: AttachmentBlobStore,
  publisherOrgId: string | undefined,
  agent: AgentRow,
  addedTemplateIds: readonly string[],
  actorId: string,
  attachmentUploader: string,
): Promise<void> {
  if (addedTemplateIds.length === 0) return;
  if (!publisherOrgId) {
    throw new ForbiddenError("Agent Template publishing is not configured on this deployment.");
  }

  // Shared single lock boundary for both adoption entry points (existing
  // PATCH and Template-backed create): the Team Skill lock always comes
  // before any Team+Template or attachment lock —
  // `team_skill_name → Team+Template → attachment`. The existing adoption
  // pre-acquires it before the config row lock, so this is a same-tx
  // idempotent re-acquire there; the Template-backed create relies on this
  // call. Accepting it for prompt/MCP-only adoptions keeps one clear order.
  await lockTeamSkillNames(db, agent.organizationId);

  // Phase 1 — lock (Team + Template, stable order) and verify every added Template.
  const templates: Array<{ id: string; payload: AgentTemplatePayload }> = [];
  for (const templateId of addedTemplateIds) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${agent.organizationId}), hashtext(${templateId}))`);
    templates.push(await lockAndVerifyTemplate(db, blobStore, publisherOrgId, templateId));
  }

  // Phase 2 — decide first-time import vs reuse per Template, based only on
  // Resource provenance (any status) in this Team.
  const plan: Array<{ template: (typeof templates)[number]; firstImport: boolean; reusable: ResourceRow[] }> = [];
  for (const template of templates) {
    const provenanceRows = await db
      .select()
      .from(resources)
      .where(and(eq(resources.organizationId, agent.organizationId), eq(resources.originTemplateId, template.id)))
      .orderBy(asc(resources.createdAt), asc(resources.id));
    plan.push({
      template,
      firstImport: provenanceRows.length === 0,
      reusable: provenanceRows.filter((row) => row.status === "active" || row.status === "stale"),
    });
  }

  // Phase 2.5 — Team Skill name invariant. The shared entry already holds
  // the Team Skill lock (see above), so this only re-checks collisions
  // with existing Team Skills and duplicates inside this adoption;
  // reusable Skills are untouched either way.
  const firstImportSkillNames = plan.flatMap((entry) =>
    entry.firstImport
      ? entry.template.payload.components.flatMap((component) => (component.type === "skill" ? [component.name] : []))
      : [],
  );
  if (firstImportSkillNames.length > 0) {
    const seen = new Set<string>();
    for (const name of firstImportSkillNames) {
      const identity = name.toLowerCase();
      if (seen.has(identity)) {
        throw adoptionConflict(`The adopted Templates provide duplicate Skill names ("${name}")`);
      }
      seen.add(identity);
      await withAdoptionConflictCode(() => assertTeamSkillNameAvailable(db, agent.organizationId, name));
    }
  }

  // Phase 3 — copy every distinct source bundle once, in stable source-id
  // order, across the whole transaction.
  const sourceBundleIds = [
    ...new Set(plan.flatMap((entry) => (entry.firstImport ? skillBundleIds(entry.template.payload.components) : []))),
  ].sort();
  // Digest right after each copy while the bytes are still a short-lived
  // local — the maps only keep small ids/digests, so a large adoption never
  // holds every ZIP buffer at once. The digest rule is unchanged (canonical
  // component plus the complete ZIP bytes).
  const bundleTargetBySourceId = new Map<string, string>();
  const digestByComponentKey = new Map<string, string>();
  for (const sourceId of sourceBundleIds) {
    const attachment = await withAdoptionConflictCode(() =>
      copyAttachmentForOrganization(db, blobStore, sourceId, agent.organizationId, attachmentUploader),
    );
    if (!attachment.data) throw new Error("Attachment copy has no PostgreSQL bytes");
    bundleTargetBySourceId.set(sourceId, attachment.id);
    const zipBytes = attachment.data;
    for (const entry of plan) {
      if (!entry.firstImport) continue;
      for (const component of entry.template.payload.components) {
        if (component.type !== "skill" || component.bundle.attachmentId !== sourceId) continue;
        digestByComponentKey.set(`${entry.template.id}:${component.key}`, templateComponentDigest(component, zipBytes));
      }
    }
  }

  // Phase 4 — import first-time components, then bind everything.
  const toBind: ResourceRow[] = [];
  for (const entry of plan) {
    if (entry.firstImport) {
      toBind.push(
        ...(await importTemplateComponents(
          db,
          agent.organizationId,
          entry.template.id,
          entry.template.payload,
          actorId,
          bundleTargetBySourceId,
          digestByComponentKey,
        )),
      );
    } else {
      toBind.push(...entry.reusable);
    }
  }
  await assertNewMcpNamesAvailable(db, agent, toBind);
  await bindAdoptedResources(db, agent, toBind, actorId);
}

/**
 * Initialize a freshly-created Agent's adopted Templates inside the caller's
 * creation transaction. The initial config stays version 1 and nothing
 * notifies — the create flow owns its own post-commit signal.
 */
export async function initializeAdoptedTemplates(
  db: Database,
  blobStore: AttachmentBlobStore,
  publisherOrgId: string | undefined,
  agent: AgentRow,
  templateIds: readonly string[],
  actorId: string,
  attachmentUploader: string,
): Promise<void> {
  if (agent.type === AGENT_TYPES.HUMAN) {
    throw new BadRequestError("Human Agents cannot adopt Agent Templates");
  }
  await adoptTemplatesInTransaction(db, blobStore, publisherOrgId, agent, templateIds, actorId, attachmentUploader);
  // The freshly-inserted config stays version 1; only the adopted set is recorded.
  await db
    .update(agentConfigs)
    .set({ templateIds: [...templateIds] })
    .where(eq(agentConfigs.agentId, agent.uuid));
}

/**
 * Full replace-set write of an existing Agent's adopted Templates. The
 * transaction re-locks the Agent row before the config row and re-checks
 * lifecycle guards against the locked row — route-level guards are only a
 * fast path. Same set is an idempotent no-op: the version is checked but
 * never bumped and no notification is sent.
 */
export async function adoptAgentTemplates(
  db: Database,
  blobStore: AttachmentBlobStore,
  publisherOrgId: string | undefined,
  notifier: Notifier,
  agent: AgentRow,
  actorId: string,
  attachmentUploader: string,
  input: UpdateAgentTemplates,
): Promise<AdoptAgentTemplatesResult> {
  const result = await db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    const [lockedAgent] = await targetDb
      .select()
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .for("update")
      .limit(1);
    if (!lockedAgent || lockedAgent.status === AGENT_STATUSES.DELETED) {
      throw new NotFoundError(`Agent "${agent.uuid}" not found`);
    }
    if (lockedAgent.type === AGENT_TYPES.HUMAN) {
      throw new BadRequestError("Human Agents cannot adopt Agent Templates");
    }
    // Suspended Agents are read-only for responsibility changes — including
    // same-set / idempotent replaces. Existing imported Team Resources stay.
    if (lockedAgent.status !== AGENT_STATUSES.ACTIVE) {
      throw new ConflictError(`Agent "${agent.uuid}" is not active and cannot change Template responsibilities`, {
        code: AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.AGENT_INACTIVE,
      });
    }
    assertMutableAgentIsNotLandingCampaignTrial(lockedAgent);
    assertNoRuntimeSwitchInProgress(lockedAgent);
    const effectiveAgent: AgentRow = {
      uuid: lockedAgent.uuid,
      organizationId: lockedAgent.organizationId,
      type: lockedAgent.type,
    };

    // Global lock order: team_skill_name → agent_configs. Ordinary Team
    // Skill writes take the advisory lock first and bump agent config
    // versions inside the same transaction, so an adoption that writes any
    // Template set must take it before the config row lock. An empty target
    // set never reaches the Skill import path and needs no lock. Phase 2.5
    // re-acquires it harmlessly (same-transaction advisory locks nest).
    if (input.templateIds.length > 0) {
      await lockTeamSkillNames(targetDb, effectiveAgent.organizationId);
    }

    const [config] = await targetDb
      .select({ version: agentConfigs.version, templateIds: agentConfigs.templateIds })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, effectiveAgent.uuid))
      .for("update")
      .limit(1);
    if (!config) throw new NotFoundError(`Agent config "${effectiveAgent.uuid}" not found`);
    if (config.version !== input.expectedVersion) {
      throw new ConflictError(
        `Agent templates "${effectiveAgent.uuid}" version mismatch: expected ${input.expectedVersion}, got ${config.version}`,
        { code: AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.VERSION_CONFLICT },
      );
    }
    const current = [...config.templateIds].sort();
    const target = [...input.templateIds].sort();
    if (current.length === target.length && current.every((id, index) => id === target[index])) {
      return { version: config.version, templateIds: target, changed: false };
    }

    const added = target.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !target.includes(id));
    // Remove first: the MCP effective-name guard below must see the target
    // replace-set's final binding baseline (a same-name A→B swap is legal),
    // and a failure anywhere rolls the removals back with the transaction.
    if (removed.length > 0) {
      await targetDb
        .delete(agentResourceBindings)
        .where(
          and(
            eq(agentResourceBindings.agentId, effectiveAgent.uuid),
            inArray(agentResourceBindings.originTemplateId, removed),
          ),
        );
    }
    await adoptTemplatesInTransaction(
      targetDb,
      blobStore,
      publisherOrgId,
      effectiveAgent,
      added,
      actorId,
      attachmentUploader,
    );
    const [updated] = await targetDb
      .update(agentConfigs)
      .set({
        version: sql`${agentConfigs.version} + 1`,
        templateIds: target,
        updatedBy: actorId,
        updatedAt: new Date(),
      })
      .where(eq(agentConfigs.agentId, effectiveAgent.uuid))
      .returning({ version: agentConfigs.version });
    if (!updated) throw new Error("Agent config update returned no row");
    return { version: updated.version, templateIds: target, changed: true };
  });
  if (result.changed) {
    await notifier.notifyConfigChange(`agent:${agent.uuid}`);
  }
  return { version: result.version, templateIds: result.templateIds };
}
