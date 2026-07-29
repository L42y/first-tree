import {
  type AgentResourceBindingInput,
  type AgentTemplateCatalogItem,
  type AgentTemplateCatalogOutput,
  type AgentTemplateDefinition,
  type AgentTemplatesForAgentOutput,
  agentTemplateMcpServerSchema,
  type CreateAgentTemplate,
  PROMPT_APPEND_MAX_LENGTH,
  promptResourcePayloadSchema,
  skillResourcePayloadSchema,
  type UpdateAgentTemplate,
  type UpdateAgentTemplates,
} from "@first-tree/shared";
import { and, arrayContains, arrayOverlaps, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { agents } from "../db/schema/agents.js";
import { attachments } from "../db/schema/attachments.js";
import { resources } from "../db/schema/resources.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from "../errors.js";
import type { Notifier } from "./notifier.js";
import { renderPromptRow } from "./prompt-rendering.js";

type AgentTemplateDbRow = typeof agentTemplates.$inferSelect;
type ResourceDbRow = typeof resources.$inferSelect;

export type AgentTemplateImpact = {
  agentId: string;
  organizationId: string;
  templateIds: string[];
  teamPromptLength: number;
  agentPromptLength: number;
};

export type AgentPromptBudgetUsage = {
  teamPromptLength: number;
  agentPromptLength: number;
};

export type AgentPromptBudgetState = {
  agentId: string;
  organizationId: string;
};

export type AgentTemplateRuntimeSelection = {
  templates: AgentTemplateDbRow[];
  resources: ResourceDbRow[];
};

export type AgentTemplatesService = {
  listCatalog(): Promise<AgentTemplateCatalogOutput>;
  getDefinition(templateId: string): Promise<AgentTemplateDefinition>;
  createTemplate(organizationId: string, input: CreateAgentTemplate, actorId: string): Promise<AgentTemplateDefinition>;
  updateTemplate(templateId: string, input: UpdateAgentTemplate, actorId: string): Promise<AgentTemplateDefinition>;
  retireTemplate(templateId: string, expectedVersion: number, actorId: string): Promise<AgentTemplateDefinition>;
  getAgentTemplates(agentId: string): Promise<AgentTemplatesForAgentOutput>;
  replaceAgentTemplates(
    agentId: string,
    input: UpdateAgentTemplates,
    actorId: string,
  ): Promise<AgentTemplatesForAgentOutput>;
};

export type AgentTemplatesServiceOptions = {
  db: Database;
  notifier: Notifier;
  publisherOrganizationId?: string;
};

function requirePublisherOrganizationId(publisherOrganizationId: string | undefined): string {
  if (!publisherOrganizationId) {
    throw new ServiceUnavailableError("The official Agent Template catalog is not configured");
  }
  return publisherOrganizationId;
}

function postgresErrorCode(err: unknown): string {
  const direct = (err as { code?: unknown })?.code;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: { code?: unknown } })?.cause?.code;
  return typeof cause === "string" ? cause : "";
}

function canonicalResourceIds(resourceIds: readonly string[]): string[] {
  return [...resourceIds].sort();
}

export async function lockAgentTemplateCatalog(targetDb: Database, publisherOrganizationId: string): Promise<void> {
  await targetDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('agent_template_catalog'), hashtext(${publisherOrganizationId}))`,
  );
}

const AGENT_TEMPLATE_UPDATE_BATCH_SIZE = 250;
const AGENT_TEMPLATE_NOTIFY_CONCURRENCY = 25;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function loadAgentPromptBudgetUsage(
  targetDb: Database,
  states: readonly AgentPromptBudgetState[],
  bindingOverrides: ReadonlyMap<string, readonly AgentResourceBindingInput[]> = new Map(),
): Promise<Map<string, AgentPromptBudgetUsage>> {
  const usageByAgent = new Map<string, AgentPromptBudgetUsage>();
  for (const stateChunk of chunks(states, AGENT_TEMPLATE_UPDATE_BATCH_SIZE)) {
    const agentIds = stateChunk.map((state) => state.agentId);
    const organizationIds = Array.from(new Set(stateChunk.map((state) => state.organizationId)));
    const resourceRows = await targetDb
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.type, "prompt"),
          inArray(resources.status, ["active", "stale"]),
          or(
            and(eq(resources.scope, "team"), inArray(resources.organizationId, organizationIds)),
            and(eq(resources.scope, "agent"), inArray(resources.ownerAgentId, agentIds)),
          ),
        ),
      );
    const storedBindings = await targetDb
      .select({
        agentId: agentResourceBindings.agentId,
        mode: agentResourceBindings.mode,
        resourceId: agentResourceBindings.resourceId,
        replacesResourceId: agentResourceBindings.replacesResourceId,
        inlinePromptBody: agentResourceBindings.inlinePromptBody,
        order: agentResourceBindings.order,
      })
      .from(agentResourceBindings)
      .where(and(inArray(agentResourceBindings.agentId, agentIds), eq(agentResourceBindings.type, "prompt")));
    const bindingsByAgent = new Map<string, AgentResourceBindingInput[]>();
    for (const binding of storedBindings) {
      const rows = bindingsByAgent.get(binding.agentId) ?? [];
      rows.push({ type: "prompt", ...binding });
      bindingsByAgent.set(binding.agentId, rows);
    }
    const resourceById = new Map(resourceRows.map((row) => [row.id, row]));
    for (const state of stateChunk) {
      const bindings = bindingOverrides.get(state.agentId) ?? bindingsByAgent.get(state.agentId) ?? [];
      const disabled = new Set<string>();
      const replaced = new Set<string>();
      const explicitlyBound = new Set<string>();
      for (const binding of bindings) {
        if (binding.mode === "disable" && binding.resourceId) disabled.add(binding.resourceId);
        if (binding.mode === "replace" && binding.replacesResourceId) replaced.add(binding.replacesResourceId);
        if (binding.mode !== "disable" && binding.resourceId) explicitlyBound.add(binding.resourceId);
      }

      const teamRows: Array<{ order: number; renderedLength: number }> = [];
      const agentRows: Array<{ order: number; renderedLength: number }> = [];
      for (const resource of resourceRows) {
        if (
          resource.organizationId !== state.organizationId ||
          resource.scope !== "team" ||
          resource.defaultEnabled !== "recommended" ||
          disabled.has(resource.id) ||
          replaced.has(resource.id) ||
          explicitlyBound.has(resource.id)
        ) {
          continue;
        }
        const parsed = promptResourcePayloadSchema.safeParse(resource.payload);
        if (!parsed.success) continue;
        teamRows.push({
          order: 0,
          renderedLength: renderPromptRow({
            name: resource.name,
            source: "team_recommended",
            body: parsed.data.body,
          }).length,
        });
      }
      for (const [index, binding] of bindings.entries()) {
        if (binding.type !== "prompt" || binding.mode === "disable") continue;
        const resource = binding.resourceId ? resourceById.get(binding.resourceId) : undefined;
        const replacedResource = binding.replacesResourceId ? resourceById.get(binding.replacesResourceId) : undefined;
        const inlineBody = binding.inlinePromptBody?.trim() ? binding.inlinePromptBody : undefined;
        const parsed = resource ? promptResourcePayloadSchema.safeParse(resource.payload) : undefined;
        const body = inlineBody ?? (parsed?.success ? parsed.data.body : undefined);
        if (!body) continue;
        const source = inlineBody
          ? ("inline_prompt" as const)
          : resource?.scope === "agent"
            ? ("agent_extra" as const)
            : resource?.defaultEnabled === "recommended"
              ? ("team_recommended" as const)
              : ("team_available" as const);
        const renderedLength = renderPromptRow({
          name: resource?.name ?? replacedResource?.name ?? "Inline prompt",
          source,
          body,
          replacesResourceId: binding.replacesResourceId,
        }).length;
        const row = { order: binding.order ?? index + 1, renderedLength };
        if (source === "team_recommended" || source === "team_available") teamRows.push(row);
        else agentRows.push(row);
      }

      let teamPromptLength = 0;
      for (const row of teamRows.sort((a, b) => a.order - b.order)) {
        if (teamPromptLength + row.renderedLength > PROMPT_APPEND_MAX_LENGTH) continue;
        teamPromptLength += row.renderedLength;
      }
      const agentPromptLength = agentRows
        .sort((a, b) => a.order - b.order)
        .reduce((total, row) => total + row.renderedLength, 0);
      usageByAgent.set(state.agentId, { teamPromptLength, agentPromptLength });
    }
  }
  return usageByAgent;
}

function assertTemplatePromptBudget(
  templates: readonly Pick<AgentTemplateDbRow, "id" | "title" | "customInstructions">[],
  usage: AgentPromptBudgetUsage = { teamPromptLength: 0, agentPromptLength: 0 },
): void {
  let total = usage.teamPromptLength;
  for (const template of templates) {
    total += renderPromptRow({
      name: template.title,
      source: "agent_template",
      body: template.customInstructions,
    }).length;
    if (total > PROMPT_APPEND_MAX_LENGTH) {
      throw new BadRequestError(
        `Agent Template selection exceeds the ${PROMPT_APPEND_MAX_LENGTH}-character instruction budget at "${template.id}"`,
      );
    }
  }
  if (total + usage.agentPromptLength > PROMPT_APPEND_MAX_LENGTH) {
    throw new BadRequestError(
      `Agent Template selection exceeds the ${PROMPT_APPEND_MAX_LENGTH}-character instruction budget at the Agent prompt`,
    );
  }
}

async function assertTemplatePromptBudgetForSelections(
  targetDb: Database,
  publisherOrganizationId: string,
  selections: readonly Pick<AgentTemplateImpact, "templateIds" | "teamPromptLength" | "agentPromptLength">[],
  candidate: Pick<AgentTemplateDbRow, "id" | "title" | "customInstructions">,
): Promise<void> {
  const selectionKeys = new Map<
    string,
    Pick<AgentTemplateImpact, "templateIds" | "teamPromptLength" | "agentPromptLength">
  >();
  for (const selection of selections) {
    selectionKeys.set(
      `${selection.teamPromptLength}:${selection.agentPromptLength}:${selection.templateIds.join("\u0000")}`,
      selection,
    );
  }
  const distinctSelections = Array.from(selectionKeys.values());
  const templateIds = Array.from(new Set(distinctSelections.flatMap((selection) => selection.templateIds)));
  const rows =
    templateIds.length === 0
      ? []
      : await targetDb
          .select()
          .from(agentTemplates)
          .where(
            and(eq(agentTemplates.organizationId, publisherOrganizationId), inArray(agentTemplates.id, templateIds)),
          );
  const byId = new Map(rows.map((row) => [row.id, row]));
  byId.set(candidate.id, { ...byId.get(candidate.id), ...candidate } as AgentTemplateDbRow);
  for (const selection of distinctSelections) {
    assertTemplatePromptBudget(
      selection.templateIds.flatMap((templateId) => {
        const row = byId.get(templateId);
        return row ? [row] : [];
      }),
      selection,
    );
  }
}

async function lockAndValidateTemplateResources(
  targetDb: Database,
  publisherOrganizationId: string,
  requestedResourceIds: readonly string[],
): Promise<ResourceDbRow[]> {
  const resourceIds = canonicalResourceIds(requestedResourceIds);
  if (resourceIds.length === 0) return [];

  const rows = await targetDb
    .select()
    .from(resources)
    .where(inArray(resources.id, resourceIds))
    .orderBy(resources.id)
    .for("share");
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const resourceId of resourceIds) {
    const resource = byId.get(resourceId);
    if (
      !resource ||
      resource.organizationId !== publisherOrganizationId ||
      resource.scope !== "team" ||
      resource.status !== "active" ||
      (resource.type !== "skill" && resource.type !== "mcp")
    ) {
      throw new BadRequestError(`Resource "${resourceId}" is not an active official Team Skill or MCP Resource`);
    }
    if (resource.type === "mcp" && !agentTemplateMcpServerSchema.safeParse(resource.payload).success) {
      throw new BadRequestError(`MCP Resource "${resourceId}" is invalid or contains unsupported secret configuration`);
    }
    if (resource.type === "skill" && !skillResourcePayloadSchema.safeParse(resource.payload).success) {
      throw new BadRequestError(`Skill Resource "${resourceId}" has an invalid Skill projection`);
    }
  }

  const skillBundleIds = rows.flatMap((row) =>
    row.type === "skill" && row.bundleAttachmentId ? [row.bundleAttachmentId] : [],
  );
  if (rows.some((row) => row.type === "skill" && !row.bundleAttachmentId)) {
    throw new BadRequestError("Every Template Skill must have a complete attachment bundle");
  }
  if (skillBundleIds.length > 0) {
    const bundleRows = await targetDb
      .select({
        id: attachments.id,
        organizationId: attachments.organizationId,
        lifecycleState: attachments.lifecycleState,
      })
      .from(attachments)
      .where(inArray(attachments.id, skillBundleIds))
      .for("share");
    const ready = new Set(
      bundleRows
        .filter((row) => row.organizationId === publisherOrganizationId && row.lifecycleState === "ready")
        .map((row) => row.id),
    );
    for (const bundleId of skillBundleIds) {
      if (!ready.has(bundleId)) {
        throw new BadRequestError(`Template Skill bundle "${bundleId}" is not ready in the official Team`);
      }
    }
  }

  return resourceIds.map((resourceId) => {
    const row = byId.get(resourceId);
    if (!row) throw new BadRequestError(`Resource "${resourceId}" is not available`);
    return row;
  });
}

function mcpName(resource: ResourceDbRow): string | null {
  if (resource.type !== "mcp") return null;
  const parsed = agentTemplateMcpServerSchema.safeParse(resource.payload);
  return parsed.success ? parsed.data.name.toLowerCase() : null;
}

async function assertMcpNamesComposable(
  targetDb: Database,
  publisherOrganizationId: string,
  candidateResources: readonly ResourceDbRow[],
  excludeTemplateId: string,
): Promise<void> {
  const candidateByName = new Map<string, string>();
  for (const resource of candidateResources) {
    const name = mcpName(resource);
    if (!name) continue;
    const existingId = candidateByName.get(name);
    if (existingId && existingId !== resource.id) {
      throw new ConflictError(`Official Templates cannot compose two different MCP Resources named "${name}"`);
    }
    candidateByName.set(name, resource.id);
  }
  if (candidateByName.size === 0) return;

  const otherTemplates = await targetDb
    .select({ resourceIds: agentTemplates.resourceIds })
    .from(agentTemplates)
    .where(and(eq(agentTemplates.organizationId, publisherOrganizationId), ne(agentTemplates.id, excludeTemplateId)));
  const otherResourceIds = Array.from(new Set(otherTemplates.flatMap((row) => row.resourceIds)));
  if (otherResourceIds.length === 0) return;

  const otherMcpResources = await targetDb
    .select()
    .from(resources)
    .where(and(inArray(resources.id, otherResourceIds), eq(resources.type, "mcp")));
  for (const resource of otherMcpResources) {
    const name = mcpName(resource);
    if (!name) continue;
    const candidateId = candidateByName.get(name);
    if (candidateId && candidateId !== resource.id) {
      throw new ConflictError(`Official Templates already use a different MCP Resource named "${name}"`);
    }
  }
}

/**
 * Resource edits bypass Template mutation, so an official MCP update must
 * preserve the same catalog-wide name invariant as Template authoring.
 */
export async function assertAgentTemplateMcpResourceUpdateComposable(
  targetDb: Database,
  publisherOrganizationId: string | undefined,
  candidate: Pick<ResourceDbRow, "id" | "organizationId" | "type" | "payload">,
): Promise<void> {
  if (!publisherOrganizationId || candidate.organizationId !== publisherOrganizationId || candidate.type !== "mcp") {
    return;
  }
  const [referencing] = await targetDb
    .select({ id: agentTemplates.id })
    .from(agentTemplates)
    .where(
      and(
        eq(agentTemplates.organizationId, publisherOrganizationId),
        arrayContains(agentTemplates.resourceIds, [candidate.id]),
      ),
    )
    .limit(1);
  if (!referencing) return;
  if (!agentTemplateMcpServerSchema.safeParse(candidate.payload).success) {
    throw new BadRequestError(
      `MCP Resource "${candidate.id}" cannot carry URL data or command arguments while referenced by an Agent Template`,
    );
  }
  await assertMcpNamesComposable(targetDb, publisherOrganizationId, [candidate as ResourceDbRow], "");
}

function rowToDefinition(row: AgentTemplateDbRow): AgentTemplateDefinition {
  return {
    id: row.id,
    organizationId: row.organizationId,
    version: row.version,
    title: row.title,
    summary: row.summary,
    outcomes: row.outcomes,
    customInstructions: row.customInstructions,
    resourceIds: row.resourceIds,
    status: row.status,
    sortOrder: row.sortOrder,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function catalogItemsForRows(targetDb: Database, rows: readonly AgentTemplateDbRow[]) {
  const resourceIds = Array.from(new Set(rows.flatMap((row) => row.resourceIds)));
  const resourceRows =
    resourceIds.length === 0 ? [] : await targetDb.select().from(resources).where(inArray(resources.id, resourceIds));
  const byId = new Map(resourceRows.map((row) => [row.id, row]));

  return rows.map((row): AgentTemplateCatalogItem => {
    const skills: AgentTemplateCatalogItem["skills"] = [];
    const mcp: AgentTemplateCatalogItem["mcp"] = [];
    for (const resourceId of row.resourceIds) {
      const resource = byId.get(resourceId);
      if (!resource) continue;
      if (resource.type === "skill") {
        const parsed = skillResourcePayloadSchema.safeParse(resource.payload);
        if (parsed.success) {
          skills.push({ name: parsed.data.name, description: parsed.data.description });
        }
      } else if (resource.type === "mcp") {
        const parsed = agentTemplateMcpServerSchema.safeParse(resource.payload);
        if (parsed.success) {
          mcp.push({ name: parsed.data.name, transport: parsed.data.transport });
        }
      }
    }
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      outcomes: row.outcomes,
      customInstructions: row.customInstructions,
      status: row.status,
      skills,
      mcp,
    };
  });
}

async function loadTemplateRowsInOrder(
  targetDb: Database,
  publisherOrganizationId: string,
  templateIds: readonly string[],
): Promise<AgentTemplateDbRow[]> {
  if (templateIds.length === 0) return [];
  const rows = await targetDb
    .select()
    .from(agentTemplates)
    .where(
      and(eq(agentTemplates.organizationId, publisherOrganizationId), inArray(agentTemplates.id, [...templateIds])),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return templateIds.flatMap((templateId) => {
    const row = byId.get(templateId);
    return row ? [row] : [];
  });
}

export async function lockAndValidateAgentTemplateSelection(
  targetDb: Database,
  publisherOrganizationId: string | undefined,
  templateIds: readonly string[],
  allowedRetiredTemplateIds: ReadonlySet<string> = new Set(),
  promptUsage: AgentPromptBudgetUsage = { teamPromptLength: 0, agentPromptLength: 0 },
): Promise<AgentTemplateDbRow[]> {
  if (templateIds.length === 0) return [];
  const publisherId = requirePublisherOrganizationId(publisherOrganizationId);
  const sortedIds = [...templateIds].sort();
  const rows = await targetDb
    .select()
    .from(agentTemplates)
    .where(inArray(agentTemplates.id, sortedIds))
    .orderBy(agentTemplates.id)
    .for("share");
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const templateId of templateIds) {
    const row = byId.get(templateId);
    if (!row || row.organizationId !== publisherId) {
      throw new BadRequestError(`Agent Template "${templateId}" is not available`);
    }
    if (row.status !== "active" && !allowedRetiredTemplateIds.has(templateId)) {
      throw new BadRequestError(`Agent Template "${templateId}" is retired and cannot be newly added`);
    }
  }
  const selectedRows = templateIds.map((templateId) => {
    const row = byId.get(templateId);
    if (!row) throw new BadRequestError(`Agent Template "${templateId}" is not available`);
    return row;
  });
  assertTemplatePromptBudget(selectedRows, promptUsage);
  return selectedRows;
}

export async function loadAgentTemplateRuntimeSelection(
  targetDb: Database,
  publisherOrganizationId: string | undefined,
  templateIds: readonly string[],
): Promise<AgentTemplateRuntimeSelection> {
  if (!publisherOrganizationId || templateIds.length === 0) return { templates: [], resources: [] };
  const templateRows = await loadTemplateRowsInOrder(targetDb, publisherOrganizationId, templateIds);
  const resourceIds = Array.from(new Set(templateRows.flatMap((row) => row.resourceIds)));
  const resourceRows =
    resourceIds.length === 0
      ? []
      : await targetDb
          .select()
          .from(resources)
          .where(
            and(
              eq(resources.organizationId, publisherOrganizationId),
              eq(resources.scope, "team"),
              eq(resources.status, "active"),
              inArray(resources.id, resourceIds),
              inArray(resources.type, ["skill", "mcp"]),
            ),
          );
  return { templates: templateRows, resources: resourceRows };
}

export async function listAgentTemplateImpactsForTemplate(
  targetDb: Database,
  templateId: string,
): Promise<AgentTemplateImpact[]> {
  const rows = await targetDb
    .select({
      agentId: agentConfigs.agentId,
      organizationId: agents.organizationId,
      templateIds: agentConfigs.templateIds,
    })
    .from(agentConfigs)
    .innerJoin(agents, eq(agents.uuid, agentConfigs.agentId))
    .where(arrayContains(agentConfigs.templateIds, [templateId]));
  const promptUsage = await loadAgentPromptBudgetUsage(
    targetDb,
    rows.map((row) => ({ agentId: row.agentId, organizationId: row.organizationId })),
  );
  return rows.map((row) => ({
    ...row,
    ...(promptUsage.get(row.agentId) ?? { teamPromptLength: 0, agentPromptLength: 0 }),
  }));
}

export async function listAgentTemplateImpactsForResource(
  targetDb: Database,
  publisherOrganizationId: string | undefined,
  resourceId: string,
): Promise<AgentTemplateImpact[]> {
  if (!publisherOrganizationId) return [];
  const templateRows = await targetDb
    .select({ id: agentTemplates.id })
    .from(agentTemplates)
    .where(
      and(
        eq(agentTemplates.organizationId, publisherOrganizationId),
        arrayContains(agentTemplates.resourceIds, [resourceId]),
      ),
    );
  const templateIds = templateRows.map((row) => row.id);
  if (templateIds.length === 0) return [];
  const rows = await targetDb
    .select({
      agentId: agentConfigs.agentId,
      organizationId: agents.organizationId,
      templateIds: agentConfigs.templateIds,
    })
    .from(agentConfigs)
    .innerJoin(agents, eq(agents.uuid, agentConfigs.agentId))
    .where(arrayOverlaps(agentConfigs.templateIds, templateIds));
  const promptUsage = await loadAgentPromptBudgetUsage(
    targetDb,
    rows.map((row) => ({ agentId: row.agentId, organizationId: row.organizationId })),
  );
  return rows.map((row) => ({
    ...row,
    ...(promptUsage.get(row.agentId) ?? { teamPromptLength: 0, agentPromptLength: 0 }),
  }));
}

export async function assertResourceNotReferencedByAgentTemplate(
  targetDb: Database,
  publisherOrganizationId: string | undefined,
  resourceId: string,
): Promise<void> {
  if (!publisherOrganizationId) return;
  const [referencing] = await targetDb
    .select({ id: agentTemplates.id })
    .from(agentTemplates)
    .where(
      and(
        eq(agentTemplates.organizationId, publisherOrganizationId),
        arrayContains(agentTemplates.resourceIds, [resourceId]),
      ),
    )
    .limit(1);
  if (referencing) {
    throw new ConflictError(
      `Resource "${resourceId}" is used by Agent Template "${referencing.id}". Remove or replace it there first.`,
    );
  }
}

export async function bumpAgentConfigsForTemplateImpacts(
  targetDb: Database,
  impacts: readonly AgentTemplateImpact[],
  publisherOrganizationId: string,
  actorId: string,
): Promise<void> {
  const byAgent = new Map(impacts.map((impact) => [impact.agentId, impact]));
  const publisherAgentIds = Array.from(byAgent.values())
    .filter((impact) => impact.organizationId === publisherOrganizationId)
    .map((impact) => impact.agentId);
  const consumerAgentIds = Array.from(byAgent.values())
    .filter((impact) => impact.organizationId !== publisherOrganizationId)
    .map((impact) => impact.agentId);

  for (const batch of chunks(publisherAgentIds, AGENT_TEMPLATE_UPDATE_BATCH_SIZE)) {
    await targetDb
      .update(agentConfigs)
      .set({
        version: sql`${agentConfigs.version} + 1`,
        updatedAt: new Date(),
        updatedBy: actorId,
      })
      .where(inArray(agentConfigs.agentId, batch));
  }
  for (const batch of chunks(consumerAgentIds, AGENT_TEMPLATE_UPDATE_BATCH_SIZE)) {
    await targetDb
      .update(agentConfigs)
      .set({
        version: sql`${agentConfigs.version} + 1`,
        updatedAt: new Date(),
        updatedBy: "system",
      })
      .where(inArray(agentConfigs.agentId, batch));
  }
}

export function createAgentTemplatesService(options: AgentTemplatesServiceOptions): AgentTemplatesService {
  const { db, notifier, publisherOrganizationId } = options;

  async function notifyAgents(agentIds: Iterable<string>): Promise<void> {
    const ids = Array.from(new Set(agentIds));
    for (const batch of chunks(ids, AGENT_TEMPLATE_NOTIFY_CONCURRENCY)) {
      await Promise.allSettled(batch.map((id) => notifier.notifyConfigChange(`agent:${id}`)));
    }
  }

  async function getDefinitionRow(templateId: string): Promise<AgentTemplateDbRow> {
    const publisherId = requirePublisherOrganizationId(publisherOrganizationId);
    const [row] = await db
      .select()
      .from(agentTemplates)
      .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.organizationId, publisherId)))
      .limit(1);
    if (!row) throw new NotFoundError(`Agent Template "${templateId}" not found`);
    return row;
  }

  async function getAgentTemplatesOutput(agentId: string): Promise<AgentTemplatesForAgentOutput> {
    const [config] = await db
      .select({
        version: agentConfigs.version,
        templateIds: agentConfigs.templateIds,
      })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agentId))
      .limit(1);
    if (!config) throw new NotFoundError(`Agent config "${agentId}" not found`);
    const templates = publisherOrganizationId
      ? await loadTemplateRowsInOrder(db, publisherOrganizationId, config.templateIds)
      : [];
    return {
      version: config.version,
      templateIds: config.templateIds,
      templates: await catalogItemsForRows(db, templates),
    };
  }

  return {
    async listCatalog() {
      if (!publisherOrganizationId) return { items: [] };
      const rows = await db
        .select()
        .from(agentTemplates)
        .where(and(eq(agentTemplates.organizationId, publisherOrganizationId), eq(agentTemplates.status, "active")))
        .orderBy(agentTemplates.sortOrder, agentTemplates.id);
      return { items: await catalogItemsForRows(db, rows) };
    },

    async getDefinition(templateId) {
      return rowToDefinition(await getDefinitionRow(templateId));
    },

    async createTemplate(organizationId, input, actorId) {
      const publisherId = requirePublisherOrganizationId(publisherOrganizationId);
      if (organizationId !== publisherId)
        throw new ForbiddenError("Only the official publisher Team manages Templates");
      let created: AgentTemplateDbRow | undefined;
      try {
        await db.transaction(async (tx) => {
          const targetDb = tx as unknown as Database;
          await lockAgentTemplateCatalog(targetDb, publisherId);
          const resourceIds = canonicalResourceIds(input.resourceIds);
          const resourceRows = await lockAndValidateTemplateResources(targetDb, publisherId, resourceIds);
          await assertMcpNamesComposable(targetDb, publisherId, resourceRows, "");
          [created] = await targetDb
            .insert(agentTemplates)
            .values({
              id: input.id,
              organizationId: publisherId,
              version: 1,
              title: input.title,
              summary: input.summary,
              outcomes: input.outcomes,
              customInstructions: input.customInstructions,
              resourceIds,
              status: "active",
              sortOrder: input.sortOrder,
              createdBy: actorId,
              updatedBy: actorId,
            })
            .returning();
        });
      } catch (err) {
        if (postgresErrorCode(err) === "23505") {
          throw new ConflictError(`Agent Template "${input.id}" already exists`);
        }
        throw err;
      }
      if (!created) throw new Error("Unexpected: Agent Template INSERT RETURNING produced no row");
      return rowToDefinition(created);
    },

    async updateTemplate(templateId, input, actorId) {
      const publisherId = requirePublisherOrganizationId(publisherOrganizationId);
      let updated: AgentTemplateDbRow | undefined;
      let impacts: AgentTemplateImpact[] = [];
      await db.transaction(async (tx) => {
        const targetDb = tx as unknown as Database;
        await lockAgentTemplateCatalog(targetDb, publisherId);
        const [current] = await targetDb
          .select()
          .from(agentTemplates)
          .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.organizationId, publisherId)))
          .for("update")
          .limit(1);
        if (!current) throw new NotFoundError(`Agent Template "${templateId}" not found`);
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `Agent Template "${templateId}" version mismatch: expected ${input.expectedVersion}, got ${current.version}`,
          );
        }

        const resourceIds = canonicalResourceIds(input.resourceIds ?? current.resourceIds);
        const resourceRows = await lockAndValidateTemplateResources(targetDb, publisherId, resourceIds);
        await assertMcpNamesComposable(targetDb, publisherId, resourceRows, templateId);
        impacts = await listAgentTemplateImpactsForTemplate(targetDb, templateId);
        if (input.title !== undefined || input.customInstructions !== undefined) {
          await assertTemplatePromptBudgetForSelections(targetDb, publisherId, impacts, {
            id: current.id,
            title: input.title ?? current.title,
            customInstructions: input.customInstructions ?? current.customInstructions,
          });
        }
        [updated] = await targetDb
          .update(agentTemplates)
          .set({
            title: input.title ?? current.title,
            summary: input.summary ?? current.summary,
            outcomes: input.outcomes ?? current.outcomes,
            customInstructions: input.customInstructions ?? current.customInstructions,
            resourceIds,
            sortOrder: input.sortOrder ?? current.sortOrder,
            version: sql`${agentTemplates.version} + 1`,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.version, input.expectedVersion)))
          .returning();
        if (!updated) throw new ConflictError(`Agent Template "${templateId}" changed during update`);
        await bumpAgentConfigsForTemplateImpacts(targetDb, impacts, publisherId, actorId);
      });
      await notifyAgents(impacts.map((impact) => impact.agentId));
      if (!updated) throw new Error("Unexpected: Agent Template UPDATE RETURNING produced no row");
      return rowToDefinition(updated);
    },

    async retireTemplate(templateId, expectedVersion, actorId) {
      const publisherId = requirePublisherOrganizationId(publisherOrganizationId);
      let retired: AgentTemplateDbRow | undefined;
      let impacts: AgentTemplateImpact[] = [];
      await db.transaction(async (tx) => {
        const targetDb = tx as unknown as Database;
        await lockAgentTemplateCatalog(targetDb, publisherId);
        const [current] = await targetDb
          .select()
          .from(agentTemplates)
          .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.organizationId, publisherId)))
          .for("update")
          .limit(1);
        if (!current) throw new NotFoundError(`Agent Template "${templateId}" not found`);
        if (current.version !== expectedVersion) {
          throw new ConflictError(
            `Agent Template "${templateId}" version mismatch: expected ${expectedVersion}, got ${current.version}`,
          );
        }
        if (current.status === "retired") {
          retired = current;
          return;
        }
        [retired] = await targetDb
          .update(agentTemplates)
          .set({
            status: "retired",
            version: sql`${agentTemplates.version} + 1`,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.version, expectedVersion)))
          .returning();
        if (!retired) throw new ConflictError(`Agent Template "${templateId}" changed during retirement`);
        impacts = await listAgentTemplateImpactsForTemplate(targetDb, templateId);
        await bumpAgentConfigsForTemplateImpacts(targetDb, impacts, publisherId, actorId);
      });
      await notifyAgents(impacts.map((impact) => impact.agentId));
      if (!retired) throw new Error("Unexpected: Agent Template retirement produced no row");
      return rowToDefinition(retired);
    },

    async getAgentTemplates(agentId) {
      return getAgentTemplatesOutput(agentId);
    },

    async replaceAgentTemplates(agentId, input, actorId) {
      let output: AgentTemplatesForAgentOutput | undefined;
      await db.transaction(async (tx) => {
        const targetDb = tx as unknown as Database;
        const [agent] = await targetDb
          .select({ type: agents.type, status: agents.status, organizationId: agents.organizationId })
          .from(agents)
          .where(eq(agents.uuid, agentId))
          .limit(1);
        if (!agent || agent.status === "deleted") throw new NotFoundError(`Agent "${agentId}" not found`);
        if (agent.type === "human") throw new BadRequestError("Human agents cannot use Agent Templates");

        // Template rows are always locked before the Agent config row. Template
        // updates follow the same order before fanning out config-version
        // bumps, avoiding a Template↔config deadlock.
        const [snapshot] = await targetDb
          .select({
            version: agentConfigs.version,
            templateIds: agentConfigs.templateIds,
          })
          .from(agentConfigs)
          .where(eq(agentConfigs.agentId, agentId))
          .limit(1);
        if (!snapshot) throw new NotFoundError(`Agent config "${agentId}" not found`);
        if (snapshot.version !== input.expectedVersion) {
          throw new ConflictError(
            `Agent Templates "${agentId}" version mismatch: expected ${input.expectedVersion}, got ${snapshot.version}`,
          );
        }
        const promptUsage = await loadAgentPromptBudgetUsage(targetDb, [
          {
            agentId,
            organizationId: agent.organizationId,
          },
        ]);
        const selectedTemplates = await lockAndValidateAgentTemplateSelection(
          targetDb,
          publisherOrganizationId,
          input.templateIds,
          new Set(snapshot.templateIds),
          promptUsage.get(agentId) ?? { teamPromptLength: 0, agentPromptLength: 0 },
        );

        const [current] = await targetDb
          .select()
          .from(agentConfigs)
          .where(eq(agentConfigs.agentId, agentId))
          .for("update")
          .limit(1);
        if (!current) throw new NotFoundError(`Agent config "${agentId}" not found`);
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `Agent Templates "${agentId}" version mismatch: expected ${input.expectedVersion}, got ${current.version}`,
          );
        }
        const [updated] = await targetDb
          .update(agentConfigs)
          .set({
            templateIds: input.templateIds,
            version: sql`${agentConfigs.version} + 1`,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(and(eq(agentConfigs.agentId, agentId), eq(agentConfigs.version, input.expectedVersion)))
          .returning({ version: agentConfigs.version });
        if (!updated) throw new ConflictError(`Agent Templates "${agentId}" changed during update`);
        output = {
          version: updated.version,
          templateIds: [...input.templateIds],
          templates: await catalogItemsForRows(targetDb, selectedTemplates),
        };
      });
      await notifyAgents([agentId]);
      if (!output) throw new Error("Unexpected: Agent Template replacement produced no output");
      return output;
    },
  };
}
