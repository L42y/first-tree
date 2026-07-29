import {
  AGENT_TEMPLATE_MAX_INSTRUCTIONS_LENGTH,
  DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
  PROMPT_APPEND_MAX_LENGTH,
  type SkillResourcePayload,
} from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { createAgent } from "../services/agent.js";
import { createAttachment } from "../services/attachment.js";
import { createOrganization } from "../services/organization.js";
import { renderPromptRow } from "../services/prompt-rendering.js";
import { buildLegacySkillBundle } from "../services/skill-bundle.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";
import { DEFAULT_ORG_ID } from "./setup.js";

describe("Agent Templates", () => {
  const getApp = useTestApp({ agentTemplatePublisherOrganizationId: DEFAULT_ORG_ID });

  it("publishes a safe catalog and creates a cross-Team Agent with Template Instructions, Skill, and MCP", async () => {
    const app = getApp();
    const publisher = await createTestAdmin(app, {
      username: `template-publisher-${crypto.randomUUID().slice(0, 8)}`,
    });
    const skill = await createOfficialSkill(app, publisher, {
      name: `research-${crypto.randomUUID().slice(0, 8)}`,
      description: "Researches a question from multiple sources.",
      body: "# Research\n\nCheck primary sources.",
      metadata: { category: "research" },
    });
    const mcp = await app.resourcesService.createTeamResource(
      publisher.organizationId,
      {
        type: "mcp",
        name: "Official browser",
        defaultEnabled: "available",
        payload: {
          name: `browser_${crypto.randomUUID().slice(0, 8)}`,
          transport: "stdio",
          command: "official-browser",
        },
      },
      publisher.memberId,
    );
    const templateId = `research-agent-${crypto.randomUUID().slice(0, 8)}`;

    const createdTemplate = await inject(
      app,
      publisher.accessToken,
      "POST",
      `/api/v1/orgs/${publisher.organizationId}/agent-templates`,
      {
        id: templateId,
        title: "Research partner",
        summary: "Turns an open question into a sourced recommendation.",
        outcomes: ["Produces a concise recommendation", "Cites primary sources"],
        customInstructions: "Investigate the request, compare evidence, and explain the recommendation.",
        resourceIds: [skill.id, mcp.id],
        sortOrder: 10,
      },
    );
    expect(createdTemplate.statusCode).toBe(201);
    expect(createdTemplate.json()).toMatchObject({
      id: templateId,
      organizationId: publisher.organizationId,
      version: 1,
      resourceIds: [mcp.id, skill.id].sort(),
      status: "active",
    });

    const consumer = await createConsumerAdmin(app, publisher);
    const catalogResponse = await inject(
      app,
      consumer.accessToken,
      "GET",
      `/api/v1/orgs/${consumer.organizationId}/agent-templates`,
    );
    expect(catalogResponse.statusCode).toBe(200);
    const catalogItem = catalogResponse
      .json<{ items: Array<Record<string, unknown>> }>()
      .items.find((item) => item.id === templateId);
    expect(catalogItem).toMatchObject({
      id: templateId,
      title: "Research partner",
      skills: [
        {
          name: (skill.payload as SkillResourcePayload).name,
          description: "Researches a question from multiple sources.",
        },
      ],
      mcp: [{ name: (mcp.payload as { name: string }).name, transport: "stdio" }],
    });
    expect(catalogItem).not.toHaveProperty("resourceIds");
    expect(catalogItem?.mcp).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "official-browser" })]),
    );

    const createAgentResponse = await inject(
      app,
      consumer.accessToken,
      "POST",
      `/api/v1/orgs/${consumer.organizationId}/agents/from-agent-templates`,
      {
        name: `templated-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Templated Researcher",
        type: "agent",
        clientId: consumer.clientId,
        runtimeProvider: "claude-code",
        templateIds: [templateId],
      },
    );
    expect(createAgentResponse.statusCode).toBe(201);
    const agentId = createAgentResponse.json<{ uuid: string }>().uuid;

    const [storedConfig] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agentId)).limit(1);
    expect(storedConfig?.templateIds).toEqual([templateId]);

    const baseConfig = await app.configService.get(agentId);
    const runtime = await app.resourcesService.resolveRuntimeConfig(baseConfig);
    expect(runtime.payload.prompt.append).toContain("## Agent Template: Research partner");
    expect(runtime.payload.prompt.append).toContain("Investigate the request");
    expect(runtime.payload.prompt.sections).toContainEqual({
      scope: "team",
      provenance: "agent_template",
      name: "Research partner",
      body: "Investigate the request, compare evidence, and explain the recommendation.",
      editable: false,
    });
    expect(runtime.payload.resourceSkills).toContainEqual(
      expect.objectContaining({
        resourceId: skill.id,
        name: (skill.payload as SkillResourcePayload).name,
        body: "# Research\n\nCheck primary sources.",
      }),
    );
    expect(runtime.payload.mcpServers).toContainEqual(
      expect.objectContaining({ name: (mcp.payload as { name: string }).name, command: "official-browser" }),
    );
  });

  it("keeps ordered live references, lets consumer Team MCP win, and protects referenced Resources", async () => {
    const app = getApp();
    const publisher = await createTestAdmin(app, {
      username: `template-live-${crypto.randomUUID().slice(0, 8)}`,
    });
    const consumer = await createConsumerAdmin(app, publisher);
    const mcpName = `docs_${crypto.randomUUID().slice(0, 8)}`;
    const queryMcpName = `search_${crypto.randomUUID().slice(0, 8)}`;
    const officialMcp = await app.resourcesService.createTeamResource(
      publisher.organizationId,
      {
        type: "mcp",
        name: "Official docs",
        defaultEnabled: "available",
        payload: { name: mcpName, transport: "stdio", command: "official-docs" },
      },
      publisher.memberId,
    );
    const officialQueryMcp = await app.resourcesService.createTeamResource(
      publisher.organizationId,
      {
        type: "mcp",
        name: "Official search",
        defaultEnabled: "available",
        payload: { name: queryMcpName, transport: "http", url: "https://official.example/mcp" },
      },
      publisher.memberId,
    );
    const consumerMcp = await app.resourcesService.createTeamResource(
      consumer.organizationId,
      {
        type: "mcp",
        name: "Team docs",
        defaultEnabled: "recommended",
        payload: {
          name: mcpName,
          transport: "stdio",
          command: "team-docs",
          args: ["--mode=readonly"],
        },
      },
      consumer.memberId,
    );
    const consumerQueryMcp = await app.resourcesService.createTeamResource(
      consumer.organizationId,
      {
        type: "mcp",
        name: "Team search",
        defaultEnabled: "recommended",
        payload: {
          name: queryMcpName,
          transport: "http",
          url: "https://consumer.example/mcp?mode=readonly",
        },
      },
      consumer.memberId,
    );
    const firstId = `first-${crypto.randomUUID().slice(0, 8)}`;
    const secondId = `second-${crypto.randomUUID().slice(0, 8)}`;
    await app.agentTemplatesService.createTemplate(
      publisher.organizationId,
      {
        id: firstId,
        title: "First",
        summary: "First ordered behavior.",
        outcomes: [],
        customInstructions: "FIRST TEMPLATE INSTRUCTION",
        resourceIds: [officialMcp.id, officialQueryMcp.id],
        sortOrder: 1,
      },
      publisher.memberId,
    );
    await app.agentTemplatesService.createTemplate(
      publisher.organizationId,
      {
        id: secondId,
        title: "Second",
        summary: "Second ordered behavior.",
        outcomes: [],
        customInstructions: "SECOND TEMPLATE INSTRUCTION",
        resourceIds: [],
        sortOrder: 2,
      },
      publisher.memberId,
    );

    const created = await inject(
      app,
      consumer.accessToken,
      "POST",
      `/api/v1/orgs/${consumer.organizationId}/agents/from-agent-templates`,
      {
        name: `ordered-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Ordered Agent",
        type: "agent",
        clientId: consumer.clientId,
        runtimeProvider: "claude-code",
        templateIds: [secondId, firstId],
      },
    );
    expect(created.statusCode).toBe(201);
    const agentId = created.json<{ uuid: string }>().uuid;

    const initialRuntime = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(agentId));
    expect(initialRuntime.payload.prompt.append.indexOf("SECOND TEMPLATE INSTRUCTION")).toBeLessThan(
      initialRuntime.payload.prompt.append.indexOf("FIRST TEMPLATE INSTRUCTION"),
    );
    expect(initialRuntime.payload.mcpServers).toHaveLength(2);
    expect(initialRuntime.payload.mcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: mcpName, command: "team-docs", args: ["--mode=readonly"] }),
        expect.objectContaining({
          name: queryMcpName,
          url: "https://consumer.example/mcp?mode=readonly",
        }),
      ]),
    );
    const effective = await app.resourcesService.resolveEffectiveResources(agentId);
    expect(effective.mcp).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: consumerMcp.id, mode: "enabled" }),
        expect.objectContaining({ resourceId: officialMcp.id, source: "agent_template", mode: "replaced" }),
        expect.objectContaining({ resourceId: consumerQueryMcp.id, mode: "enabled" }),
        expect.objectContaining({ resourceId: officialQueryMcp.id, source: "agent_template", mode: "replaced" }),
      ]),
    );

    const selected = await inject(app, consumer.accessToken, "GET", `/api/v1/agents/${agentId}/templates`);
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      version: 1,
      templateIds: [secondId, firstId],
    });

    const reordered = await inject(app, consumer.accessToken, "PATCH", `/api/v1/agents/${agentId}/templates`, {
      expectedVersion: 1,
      templateIds: [firstId, secondId],
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json()).toMatchObject({
      version: 2,
      templateIds: [firstId, secondId],
    });
    const reorderedRuntime = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(agentId));
    expect(reorderedRuntime.payload.prompt.append.indexOf("FIRST TEMPLATE INSTRUCTION")).toBeLessThan(
      reorderedRuntime.payload.prompt.append.indexOf("SECOND TEMPLATE INSTRUCTION"),
    );

    const updated = await app.agentTemplatesService.updateTemplate(
      firstId,
      { expectedVersion: 1, customInstructions: "FIRST TEMPLATE UPDATED" },
      publisher.memberId,
    );
    expect(updated.version).toBe(2);
    const [afterUpdate] = await app.db
      .select({ version: agentConfigs.version, updatedBy: agentConfigs.updatedBy })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agentId))
      .limit(1);
    expect(afterUpdate).toEqual({ version: 3, updatedBy: "system" });
    const updatedRuntime = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(agentId));
    expect(updatedRuntime.payload.prompt.append).toContain("FIRST TEMPLATE UPDATED");

    const retired = await app.agentTemplatesService.retireTemplate(firstId, 2, publisher.memberId);
    expect(retired).toMatchObject({ status: "retired", version: 3 });
    const retiredAgain = await app.agentTemplatesService.retireTemplate(firstId, 3, publisher.memberId);
    expect(retiredAgain).toMatchObject({ status: "retired", version: 3 });
    const catalog = await app.agentTemplatesService.listCatalog();
    expect(catalog.items.some((item) => item.id === firstId)).toBe(false);
    const existingRuntime = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(agentId));
    expect(existingRuntime.payload.prompt.append).toContain("FIRST TEMPLATE UPDATED");

    const rejected = await inject(
      app,
      consumer.accessToken,
      "POST",
      `/api/v1/orgs/${consumer.organizationId}/agents/from-agent-templates`,
      {
        name: `retired-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Retired Template Agent",
        type: "agent",
        clientId: consumer.clientId,
        runtimeProvider: "claude-code",
        templateIds: [firstId],
      },
    );
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toMatch(/retired/i);

    const retireResource = await inject(app, publisher.accessToken, "DELETE", `/api/v1/resources/${officialMcp.id}`);
    expect(retireResource.statusCode).toBe(409);
    expect(retireResource.json<{ error: string }>().error).toMatch(/Agent Template/i);
  });

  it("keeps a legal boundary Template in runtime and rejects over-budget combinations and live updates", async () => {
    const app = getApp();
    const publisher = await createTestAdmin(app, {
      username: `template-budget-${crypto.randomUUID().slice(0, 8)}`,
    });
    const consumer = await createConsumerAdmin(app, publisher);
    const boundaryId = `boundary-${crypto.randomUUID().slice(0, 8)}`;
    await app.agentTemplatesService.createTemplate(
      publisher.organizationId,
      {
        id: boundaryId,
        title: "Boundary",
        summary: "Exercises the legal instruction boundary.",
        outcomes: [],
        customInstructions: "x".repeat(AGENT_TEMPLATE_MAX_INSTRUCTIONS_LENGTH),
        resourceIds: [],
        sortOrder: 1,
      },
      publisher.memberId,
    );

    const boundaryAgent = await inject(
      app,
      consumer.accessToken,
      "POST",
      `/api/v1/orgs/${consumer.organizationId}/agents/from-agent-templates`,
      {
        name: `boundary-agent-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        clientId: consumer.clientId,
        templateIds: [boundaryId],
      },
    );
    expect(boundaryAgent.statusCode).toBe(201);
    const boundaryRuntime = await app.resourcesService.resolveRuntimeConfig(
      await app.configService.get(boundaryAgent.json<{ uuid: string }>().uuid),
    );
    expect(boundaryRuntime.payload.prompt.sections).toContainEqual(
      expect.objectContaining({
        provenance: "agent_template",
        name: "Boundary",
        body: "x".repeat(AGENT_TEMPLATE_MAX_INSTRUCTIONS_LENGTH),
      }),
    );
    await expect(
      app.resourcesService.replaceAgentResources(
        boundaryAgent.json<{ uuid: string }>().uuid,
        {
          expectedVersion: 1,
          bindings: [
            {
              type: "prompt",
              mode: "include",
              resourceId: null,
              inlinePromptBody: `Agent-owned prompt must not be silently discarded. ${"a".repeat(500)}`,
            },
          ],
        },
        consumer.memberId,
      ),
    ).rejects.toThrow(/instruction budget/i);
    const [unchangedBoundaryConfig] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, boundaryAgent.json<{ uuid: string }>().uuid));
    expect(unchangedBoundaryConfig?.version).toBe(1);
    expect(
      await app.db
        .select({ id: agentResourceBindings.id })
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, boundaryAgent.json<{ uuid: string }>().uuid)),
    ).toEqual([]);

    const replacementName = "R".repeat(200);
    const replaceablePrompt = await app.resourcesService.createTeamResource(
      consumer.organizationId,
      {
        type: "prompt",
        name: replacementName,
        defaultEnabled: "available",
        payload: { body: "Team baseline." },
      },
      consumer.memberId,
    );
    const replacementBody = "Agent replacement.";
    const boundaryTemplateLength = renderPromptRow({
      name: "Boundary",
      source: "agent_template",
      body: "x".repeat(AGENT_TEMPLATE_MAX_INSTRUCTIONS_LENGTH),
    }).length;
    expect(
      boundaryTemplateLength + renderPromptRow({ name: "", source: "inline_prompt", body: replacementBody }).length,
    ).toBeLessThanOrEqual(PROMPT_APPEND_MAX_LENGTH);
    expect(
      boundaryTemplateLength +
        renderPromptRow({
          name: replacementName,
          source: "inline_prompt",
          body: replacementBody,
          replacesResourceId: replaceablePrompt.id,
        }).length,
    ).toBeGreaterThan(PROMPT_APPEND_MAX_LENGTH);
    await expect(
      app.resourcesService.replaceAgentResources(
        boundaryAgent.json<{ uuid: string }>().uuid,
        {
          expectedVersion: 1,
          bindings: [
            {
              type: "prompt",
              mode: "replace",
              resourceId: null,
              replacesResourceId: replaceablePrompt.id,
              inlinePromptBody: replacementBody,
            },
          ],
        },
        consumer.memberId,
      ),
    ).rejects.toThrow(/instruction budget/i);
    expect(
      await app.db
        .select({ id: agentResourceBindings.id })
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, boundaryAgent.json<{ uuid: string }>().uuid)),
    ).toEqual([]);

    const priorityId = `team-priority-${crypto.randomUUID().slice(0, 8)}`;
    await app.agentTemplatesService.createTemplate(
      publisher.organizationId,
      {
        id: priorityId,
        title: "Team priority",
        summary: "Confirms Team prompt budget precedence.",
        outcomes: [],
        customInstructions: "T".repeat(128),
        resourceIds: [],
        sortOrder: 2,
      },
      publisher.memberId,
    );
    const priorityConsumer = await createConsumerAdmin(app, publisher);
    const priorityAgent = await inject(
      app,
      priorityConsumer.accessToken,
      "POST",
      `/api/v1/orgs/${priorityConsumer.organizationId}/agents/from-agent-templates`,
      {
        name: `team-priority-agent-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        clientId: priorityConsumer.clientId,
        templateIds: [priorityId],
      },
    );
    expect(priorityAgent.statusCode).toBe(201);
    const teamPromptName = "Priority Team prompt";
    const teamPromptHeaderLength = renderPromptRow({
      name: teamPromptName,
      source: "team_recommended",
      body: "",
    }).length;
    const priorityTeamPrompt = await app.resourcesService.createTeamResource(
      priorityConsumer.organizationId,
      {
        type: "prompt",
        name: teamPromptName,
        defaultEnabled: "recommended",
        payload: { body: "P".repeat(PROMPT_APPEND_MAX_LENGTH - teamPromptHeaderLength - 64) },
      },
      priorityConsumer.memberId,
    );
    const priorityEffective = await app.resourcesService.resolveEffectiveResources(
      priorityAgent.json<{ uuid: string }>().uuid,
    );
    expect(priorityEffective.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: priorityTeamPrompt.id, mode: "enabled" }),
        expect.objectContaining({ id: `template:${priorityId}:prompt`, mode: "unavailable" }),
      ]),
    );
    const rejectedAfterTeamPrompt = await inject(
      app,
      priorityConsumer.accessToken,
      "POST",
      `/api/v1/orgs/${priorityConsumer.organizationId}/agents/from-agent-templates`,
      {
        name: `team-priority-rejected-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        clientId: priorityConsumer.clientId,
        templateIds: [priorityId],
      },
    );
    expect(rejectedAfterTeamPrompt.statusCode).toBe(400);
    expect(rejectedAfterTeamPrompt.json<{ error: string }>().error).toMatch(/instruction budget/i);

    const firstId = `budget-first-${crypto.randomUUID().slice(0, 8)}`;
    const secondId = `budget-second-${crypto.randomUUID().slice(0, 8)}`;
    for (const [id, title] of [
      [firstId, "Budget first"],
      [secondId, "Budget second"],
    ] as const) {
      await app.agentTemplatesService.createTemplate(
        publisher.organizationId,
        {
          id,
          title,
          summary: "A large composable Template.",
          outcomes: [],
          customInstructions: "y".repeat(20_000),
          resourceIds: [],
          sortOrder: 2,
        },
        publisher.memberId,
      );
    }
    const overBudget = await inject(
      app,
      consumer.accessToken,
      "POST",
      `/api/v1/orgs/${consumer.organizationId}/agents/from-agent-templates`,
      {
        name: `over-budget-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        clientId: consumer.clientId,
        templateIds: [firstId, secondId],
      },
    );
    expect(overBudget.statusCode).toBe(400);
    expect(overBudget.json<{ error: string }>().error).toMatch(/instruction budget/i);

    const liveId = `live-budget-${crypto.randomUUID().slice(0, 8)}`;
    await app.agentTemplatesService.createTemplate(
      publisher.organizationId,
      {
        id: liveId,
        title: "Live budget",
        summary: "Stays coherent during live updates.",
        outcomes: [],
        customInstructions: "SHORT TEMPLATE",
        resourceIds: [],
        sortOrder: 3,
      },
      publisher.memberId,
    );
    const liveAgent = await inject(
      app,
      consumer.accessToken,
      "POST",
      `/api/v1/orgs/${consumer.organizationId}/agents/from-agent-templates`,
      {
        name: `live-budget-agent-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        clientId: consumer.clientId,
        templateIds: [liveId],
      },
    );
    const liveAgentId = liveAgent.json<{ uuid: string }>().uuid;
    const agentPromptBody = `AGENT OWN INSTRUCTIONS ${"z".repeat(600)}`;
    await app.resourcesService.replaceAgentResources(
      liveAgentId,
      {
        expectedVersion: 1,
        bindings: [{ type: "prompt", mode: "include", resourceId: null, inlinePromptBody: agentPromptBody }],
      },
      consumer.memberId,
    );

    await expect(
      app.agentTemplatesService.updateTemplate(
        liveId,
        {
          expectedVersion: 1,
          customInstructions: "w".repeat(AGENT_TEMPLATE_MAX_INSTRUCTIONS_LENGTH),
        },
        publisher.memberId,
      ),
    ).rejects.toThrow(/instruction budget/i);
    const liveRuntime = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(liveAgentId));
    expect(liveRuntime.payload.prompt.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provenance: "agent_template", body: "SHORT TEMPLATE" }),
        expect.objectContaining({ provenance: "agent", body: expect.stringContaining("AGENT OWN INSTRUCTIONS") }),
      ]),
    );

    const legacyOnceId = `legacy-once-${crypto.randomUUID().slice(0, 8)}`;
    await app.agentTemplatesService.createTemplate(
      publisher.organizationId,
      {
        id: legacyOnceId,
        title: "Legacy prompt counted once",
        summary: "Verifies migrated legacy prompt payloads are not double-counted.",
        outcomes: [],
        customInstructions: "L".repeat(20_000),
        resourceIds: [],
        sortOrder: 4,
      },
      publisher.memberId,
    );
    const legacyAgent = await inject(
      app,
      consumer.accessToken,
      "POST",
      `/api/v1/orgs/${consumer.organizationId}/agents`,
      {
        name: `legacy-once-agent-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        clientId: consumer.clientId,
      },
    );
    expect(legacyAgent.statusCode).toBe(201);
    const legacyAgentId = legacyAgent.json<{ uuid: string }>().uuid;
    const migratedPromptBody = "M".repeat(10_000);
    await app.resourcesService.replaceAgentResources(
      legacyAgentId,
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: migratedPromptBody,
          },
        ],
      },
      consumer.memberId,
    );
    const migratedConfig = await app.configService.get(legacyAgentId);
    await app.db
      .update(agentConfigs)
      .set({
        payload: {
          ...migratedConfig.payload,
          prompt: { ...migratedConfig.payload.prompt, append: migratedPromptBody },
        },
      })
      .where(eq(agentConfigs.agentId, legacyAgentId));
    await expect(
      app.agentTemplatesService.replaceAgentTemplates(
        legacyAgentId,
        { expectedVersion: 2, templateIds: [legacyOnceId] },
        consumer.memberId,
      ),
    ).resolves.toMatchObject({ version: 3, templateIds: [legacyOnceId] });
  });

  it("keeps permissive MCP Resources local and strictly guards cross-Team Template projection", async () => {
    const app = getApp();
    const publisher = await createTestAdmin(app, {
      username: `template-mcp-guard-${crypto.randomUUID().slice(0, 8)}`,
    });
    const consumer = await createConsumerAdmin(app, publisher);
    const queryResource = await app.resourcesService.createTeamResource(
      publisher.organizationId,
      {
        type: "mcp",
        name: "Query endpoint",
        defaultEnabled: "available",
        payload: {
          name: "query_endpoint",
          transport: "http",
          url: "https://mcp.example/service?mode=readonly",
        },
      },
      publisher.memberId,
    );
    const argsResource = await app.resourcesService.createTeamResource(
      publisher.organizationId,
      {
        type: "mcp",
        name: "Args endpoint",
        defaultEnabled: "available",
        payload: {
          name: "args_endpoint",
          transport: "stdio",
          command: "args-endpoint",
          args: ["--mode=readonly"],
        },
      },
      publisher.memberId,
    );
    for (const [index, resource] of [queryResource, argsResource].entries()) {
      const rejectedAttach = await inject(
        app,
        publisher.accessToken,
        "POST",
        `/api/v1/orgs/${publisher.organizationId}/agent-templates`,
        {
          id: `strict-rejected-${index}-${crypto.randomUUID().slice(0, 8)}`,
          title: `Strict rejected ${index}`,
          summary: "Must not project URL data or command arguments across Teams.",
          outcomes: [],
          customInstructions: "Safe instructions.",
          resourceIds: [resource.id],
          sortOrder: index,
        },
      );
      expect(rejectedAttach.statusCode).toBe(400);
    }

    const safe = await app.resourcesService.createTeamResource(
      publisher.organizationId,
      {
        type: "mcp",
        name: "Safe endpoint",
        defaultEnabled: "available",
        payload: { name: "safe_endpoint", transport: "stdio", command: "safe-endpoint" },
      },
      publisher.memberId,
    );
    const safeTemplateId = `strict-safe-${crypto.randomUUID().slice(0, 8)}`;
    await app.agentTemplatesService.createTemplate(
      publisher.organizationId,
      {
        id: safeTemplateId,
        title: "Strict safe",
        summary: "Uses a cross-Team safe MCP definition.",
        outcomes: [],
        customInstructions: "Use the safe endpoint.",
        resourceIds: [safe.id],
        sortOrder: 10,
      },
      publisher.memberId,
    );
    const createdAgent = await inject(
      app,
      consumer.accessToken,
      "POST",
      `/api/v1/orgs/${consumer.organizationId}/agents/from-agent-templates`,
      {
        name: `strict-safe-agent-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        clientId: consumer.clientId,
        templateIds: [safeTemplateId],
      },
    );
    expect(createdAgent.statusCode).toBe(201);
    const agentId = createdAgent.json<{ uuid: string }>().uuid;

    for (const payload of [
      {
        name: "safe_endpoint",
        transport: "http",
        url: "https://mcp.example/service?mode=readonly",
      },
      {
        name: "safe_endpoint",
        transport: "stdio",
        command: "safe-endpoint",
        args: ["--mode=readonly"],
      },
    ]) {
      const rejectedUpdate = await inject(app, publisher.accessToken, "PATCH", `/api/v1/resources/${safe.id}`, {
        payload,
      });
      expect(rejectedUpdate.statusCode).toBe(400);
    }
    expect((await app.resourcesService.getResource(safe.id)).payload).toEqual({
      name: "safe_endpoint",
      transport: "stdio",
      command: "safe-endpoint",
    });
    const safeRuntime = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(agentId));
    expect(safeRuntime.payload.mcpServers).toContainEqual(
      expect.objectContaining({ name: "safe_endpoint", command: "safe-endpoint" }),
    );

    const legacyResource = await app.resourcesService.createTeamResource(
      publisher.organizationId,
      {
        type: "mcp",
        name: "Legacy query endpoint",
        defaultEnabled: "available",
        payload: {
          name: "legacy_query_endpoint",
          transport: "http",
          url: "https://legacy.example/mcp?mode=readonly",
        },
      },
      publisher.memberId,
    );
    const legacyTemplateId = `legacy-strict-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(agentTemplates).values({
      id: legacyTemplateId,
      organizationId: publisher.organizationId,
      title: "Legacy strict projection",
      summary: "Simulates a row written before strict cross-Team validation.",
      outcomes: [],
      customInstructions: "Legacy instructions.",
      resourceIds: [legacyResource.id],
      status: "active",
      sortOrder: 11,
      createdBy: publisher.memberId,
      updatedBy: publisher.memberId,
    });
    const catalog = await app.agentTemplatesService.listCatalog();
    expect(catalog.items.find((item) => item.id === legacyTemplateId)?.mcp).toEqual([]);
    await app.db
      .update(agentConfigs)
      .set({ templateIds: [safeTemplateId, legacyTemplateId] })
      .where(eq(agentConfigs.agentId, agentId));
    const legacyEffective = await app.resourcesService.resolveEffectiveResources(agentId);
    expect(legacyEffective.unavailable).toContainEqual({
      type: "mcp",
      id: legacyResource.id,
      reason: "invalid_mcp_payload",
    });
    const legacyRuntime = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(agentId));
    expect(legacyRuntime.payload.mcpServers.some((server) => server.name === "legacy_query_endpoint")).toBe(false);
  });

  it("serializes catalog-wide MCP renames so only one conflicting write commits", async () => {
    const app = getApp();
    const publisher = await createTestAdmin(app, {
      username: `template-mcp-race-${crypto.randomUUID().slice(0, 8)}`,
    });
    const resources = await Promise.all(
      ["alpha", "beta"].map((name) =>
        app.resourcesService.createTeamResource(
          publisher.organizationId,
          {
            type: "mcp" as const,
            name,
            defaultEnabled: "available" as const,
            payload: { name, transport: "stdio" as const, command: `${name}-command` },
          },
          publisher.memberId,
        ),
      ),
    );
    for (const [index, resource] of resources.entries()) {
      await app.agentTemplatesService.createTemplate(
        publisher.organizationId,
        {
          id: `rename-${index}-${crypto.randomUUID().slice(0, 8)}`,
          title: `Rename ${index}`,
          summary: "Protects the catalog-wide MCP name invariant.",
          outcomes: [],
          customInstructions: `Template ${index}`,
          resourceIds: [resource.id],
          sortOrder: index,
        },
        publisher.memberId,
      );
    }

    const results = await Promise.allSettled(
      resources.map((resource, index) =>
        app.resourcesService.updateResource(
          resource.id,
          {
            payload: {
              name: "shared_name",
              transport: "stdio",
              command: `command-${index}`,
            },
          },
          publisher.memberId,
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const finalNames = await Promise.all(
      resources.map(async (resource) => {
        const current = await app.resourcesService.getResource(resource.id);
        return (current.payload as { name: string }).name;
      }),
    );
    expect(finalNames.filter((name) => name === "shared_name")).toHaveLength(1);
  });

  it("bounds notification concurrency while fanning out a popular Template update", async () => {
    const app = getApp();
    const publisher = await createTestAdmin(app, {
      username: `template-fanout-${crypto.randomUUID().slice(0, 8)}`,
    });
    const consumer = await createConsumerAdmin(app, publisher);
    const templateId = `fanout-${crypto.randomUUID().slice(0, 8)}`;
    await app.agentTemplatesService.createTemplate(
      publisher.organizationId,
      {
        id: templateId,
        title: "Fanout",
        summary: "Exercises bounded update notification.",
        outcomes: [],
        customInstructions: "Initial",
        resourceIds: [],
        sortOrder: 1,
      },
      publisher.memberId,
    );
    const rows = Array.from({ length: 260 }, (_, index) => {
      const uuid = uuidv7();
      return {
        uuid,
        name: `fanout-${index}-${crypto.randomUUID().slice(0, 6)}`,
        organizationId: consumer.organizationId,
        type: "agent",
        displayName: `Fanout ${index}`,
        inboxId: `inbox_${uuid}`,
        managerId: consumer.memberId,
        clientId: consumer.clientId,
      };
    });
    await app.db.insert(agents).values(rows);
    await app.db.insert(agentConfigs).values(
      rows.map((row) => ({
        agentId: row.uuid,
        payload: DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
        templateIds: [templateId],
        updatedBy: "system",
      })),
    );

    let active = 0;
    let maxActive = 0;
    const notify = vi.spyOn(app.notifier, "notifyConfigChange").mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    });
    try {
      await app.agentTemplatesService.updateTemplate(
        templateId,
        { expectedVersion: 1, customInstructions: "Updated" },
        publisher.memberId,
      );
      expect(notify).toHaveBeenCalledTimes(rows.length);
      expect(maxActive).toBeLessThanOrEqual(25);
    } finally {
      notify.mockRestore();
    }
  });
});

async function createOfficialSkill(
  app: FastifyInstance,
  publisher: Awaited<ReturnType<typeof createTestAdmin>>,
  payload: SkillResourcePayload,
) {
  const bundle = buildLegacySkillBundle(payload);
  const attachment = await createAttachment(app.db, {
    organizationId: publisher.organizationId,
    mimeType: "application/zip",
    filename: `${payload.name}.zip`,
    body: bundle,
    contentLength: bundle.byteLength,
    uploadedBy: publisher.humanAgentUuid,
  });
  return app.resourcesService.createTeamResource(
    publisher.organizationId,
    {
      type: "skill",
      defaultEnabled: "available",
      bundleAttachmentId: attachment.id,
    },
    publisher.memberId,
  );
}

async function createConsumerAdmin(app: FastifyInstance, user: Awaited<ReturnType<typeof createTestAdmin>>) {
  const organization = await createOrganization(app.db, {
    name: `template-consumer-${crypto.randomUUID().slice(0, 10)}`,
    displayName: "Template Consumer",
  });
  const memberId = uuidv7();
  const human = await app.db.transaction(async (tx) => {
    const row = await createAgent(
      tx as unknown as typeof app.db,
      {
        name: `consumer-human-${crypto.randomUUID().slice(0, 8)}`,
        type: "human",
        displayName: "Template Consumer",
        managerId: memberId,
        organizationId: organization.id,
      },
      { force: true },
    );
    await tx.insert(members).values({
      id: memberId,
      userId: user.userId,
      organizationId: organization.id,
      agentId: row.uuid,
      role: "admin",
    });
    return row;
  });
  const clientId = `template-client-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: user.userId,
    organizationId: organization.id,
    status: "connected",
  });
  return {
    accessToken: user.accessToken,
    organizationId: organization.id,
    memberId,
    humanAgentUuid: human.uuid,
    clientId,
  };
}

async function inject(
  app: FastifyInstance,
  accessToken: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return await app.inject({
    method: method as "GET" | "POST" | "PATCH" | "DELETE",
    url,
    headers: { authorization: `Bearer ${accessToken}` },
    ...(payload ? { payload } : {}),
  });
}
