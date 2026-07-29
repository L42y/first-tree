import type { SkillResourcePayload } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { createAgent } from "../services/agent.js";
import { createAttachment } from "../services/attachment.js";
import { createOrganization } from "../services/organization.js";
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
          args: ["--safe"],
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
      `/api/v1/orgs/${consumer.organizationId}/agents`,
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
    const consumerMcp = await app.resourcesService.createTeamResource(
      consumer.organizationId,
      {
        type: "mcp",
        name: "Team docs",
        defaultEnabled: "recommended",
        payload: { name: mcpName, transport: "stdio", command: "team-docs" },
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
        resourceIds: [officialMcp.id],
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

    const created = await inject(app, consumer.accessToken, "POST", `/api/v1/orgs/${consumer.organizationId}/agents`, {
      name: `ordered-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Ordered Agent",
      type: "agent",
      clientId: consumer.clientId,
      runtimeProvider: "claude-code",
      templateIds: [secondId, firstId],
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json<{ uuid: string }>().uuid;

    const initialRuntime = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(agentId));
    expect(initialRuntime.payload.prompt.append.indexOf("SECOND TEMPLATE INSTRUCTION")).toBeLessThan(
      initialRuntime.payload.prompt.append.indexOf("FIRST TEMPLATE INSTRUCTION"),
    );
    expect(initialRuntime.payload.mcpServers).toEqual([
      expect.objectContaining({ name: mcpName, command: "team-docs" }),
    ]);
    const effective = await app.resourcesService.resolveEffectiveResources(agentId);
    expect(effective.mcp).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: consumerMcp.id, mode: "enabled" }),
        expect.objectContaining({ resourceId: officialMcp.id, source: "agent_template", mode: "replaced" }),
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

    const rejected = await inject(app, consumer.accessToken, "POST", `/api/v1/orgs/${consumer.organizationId}/agents`, {
      name: `retired-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Retired Template Agent",
      type: "agent",
      clientId: consumer.clientId,
      runtimeProvider: "claude-code",
      templateIds: [firstId],
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toMatch(/retired/i);

    const retireResource = await inject(app, publisher.accessToken, "DELETE", `/api/v1/resources/${officialMcp.id}`);
    expect(retireResource.statusCode).toBe(409);
    expect(retireResource.json<{ error: string }>().error).toMatch(/Agent Template/i);
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
