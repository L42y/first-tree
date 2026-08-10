import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agents/identity.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedAgentFactory, useTestApp } from "./helpers.js";

const PUBLISHER_ORG_ID = "agent-template-publisher-org-test";
const INTERNAL_URL = "/api/v1/internal/agent-templates";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;
type TestApp = ReturnType<ReturnType<typeof useTestApp>>;

function skillZip(name: string): Buffer {
  return Buffer.from(
    zipSync({ "SKILL.md": strToU8(`---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n\nOK.`) }),
  );
}

async function createPublisherAdmin(app: TestApp): Promise<Admin> {
  const admin = await createTestAdmin(app, { username: `pub-${crypto.randomUUID().slice(0, 8)}` });
  await app.db
    .insert(organizations)
    .values({ id: PUBLISHER_ORG_ID, name: "official-publisher", displayName: "Official Publisher" })
    .onConflictDoNothing();
  const memberId = uuidv7();
  await app.db.transaction(async (tx) => {
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `publisher-human-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Publisher Human",
      managerId: memberId,
      organizationId: PUBLISHER_ORG_ID,
    });
    await tx.insert(members).values({
      id: memberId,
      userId: admin.userId,
      organizationId: PUBLISHER_ORG_ID,
      agentId: human.uuid,
      role: "admin",
    });
  });
  return admin;
}

function call(
  app: TestApp,
  admin: { accessToken: string } | null,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    ...(admin ? { headers: { authorization: `Bearer ${admin.accessToken}` } } : {}),
    ...(payload !== undefined ? { payload } : {}),
  });
}

function publicProfile() {
  return {
    tagline: "Review-ready PRs",
    purpose: "A starting point for a PR engineering agent.",
    targetUsers: "Engineers running multiple agents.",
    userValue: "Start from a curated workflow.",
    instructionsSummary: "Guides review-ready delivery.",
    toolsAndSkillsSummary: "One review skill and one MCP server.",
  };
}

async function publishTemplate(app: TestApp, publisher: Admin, slug: string, components: unknown[]) {
  const created = await call(app, publisher, "POST", INTERNAL_URL, {
    slug,
    name: slug,
    public: publicProfile(),
    components,
  });
  expect(created.statusCode).toBe(201);
  const draft = created.json<{ id: string; updatedAt: string }>();
  const published = await call(app, publisher, "POST", `${INTERNAL_URL}/${draft.id}/publish`, {
    expectedUpdatedAt: draft.updatedAt,
  });
  expect(published.statusCode).toBe(200);
  return { id: draft.id, slug, updatedAt: published.json<{ updatedAt: string }>().updatedAt };
}

describe("Agent Template projection", () => {
  const getApp = useTestApp({ agentTemplatePublisherOrgId: PUBLISHER_ORG_ID });

  async function adoptAndRead(app: TestApp, admin: Admin, agentUuid: string, templateIds: string[]) {
    const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agentUuid));
    const reply = await call(app, admin, "PATCH", `/api/v1/agents/${agentUuid}/templates`, {
      expectedVersion: config?.version ?? 1,
      templateIds,
    });
    expect(reply.statusCode).toBe(200);
    return reply.json<{
      version: number;
      templateIds: string[];
      adoptedTemplates: Array<Record<string, unknown>>;
      effective: {
        prompts: Array<{ name: string; originTemplateId: string | null; source: string }>;
        skills: Array<{ name: string; originTemplateId: string | null }>;
        mcp: Array<{ name: string; originTemplateId: string | null }>;
      };
      availableTeamResources: Array<{ id: string; originTemplateId: string | null; payload: unknown }>;
    }>();
  }

  it("projects adopted summaries and origin ids across prompt, skill, and mcp", async () => {
    const app = getApp();
    const publisher = await createPublisherAdmin(app);
    const bundleUpload = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${PUBLISHER_ORG_ID}/attachments`,
      headers: {
        authorization: `Bearer ${publisher.accessToken}`,
        "content-type": "application/octet-stream",
        [ATTACHMENT_MIME_HEADER]: "application/zip",
        [ATTACHMENT_FILENAME_HEADER]: "skill.zip",
      },
      payload: skillZip("proj-skill"),
    });
    const bundleId = bundleUpload.json<{ id: string }>().id;
    const template = await publishTemplate(app, publisher, `proj-${crypto.randomUUID().slice(0, 6)}`, [
      {
        key: "instructions",
        type: "prompt",
        name: "PR Instructions",
        payload: { body: "SECRET-RAW-INSTRUCTIONS", description: "core" },
      },
      { key: "proj-skill", type: "skill", bundleAttachmentId: bundleId },
      {
        key: "github-mcp",
        type: "mcp",
        name: "GitHub MCP",
        payload: { name: "github", transport: "http", url: "https://mcp.example/github" },
      },
    ]);

    const createAgentRow = await seedAgentFactory(app);
    const agent = await createAgentRow({ name: `proj-${crypto.randomUUID().slice(0, 6)}` });
    const admin = await createTestAdmin(app, { username: `pj-${crypto.randomUUID().slice(0, 8)}` });
    const body = await adoptAndRead(app, admin, agent.uuid, [template.id]);

    expect(body.templateIds).toEqual([template.id]);
    expect(body.adoptedTemplates).toHaveLength(1);
    const summary = body.adoptedTemplates[0] as {
      id: string;
      status: string;
      slug: string;
      name: string;
      public: { tagline: string } | null;
      replacement: unknown;
    };
    expect(summary.id).toBe(template.id);
    expect(summary.status).toBe("active");
    expect(summary.slug).toBe(template.slug);
    expect(summary.public?.tagline).toBe("Review-ready PRs");
    expect(summary.replacement).toBeNull();

    // No private component data leaks through the summaries.
    const serialized = JSON.stringify(body.adoptedTemplates);
    expect(serialized).not.toContain("SECRET-RAW-INSTRUCTIONS");
    expect(serialized).not.toContain(bundleId);
    expect(serialized).not.toContain("mcp.example");
    expect(serialized).not.toContain("components");

    // Effective rows carry the historical origin; inline/ordinary rows stay null.
    expect(body.effective.prompts.every((row) => row.originTemplateId === template.id)).toBe(true);
    expect(body.effective.skills.every((row) => row.originTemplateId === template.id)).toBe(true);
    expect(body.effective.mcp.every((row) => row.originTemplateId === template.id)).toBe(true);
    const imported = body.availableTeamResources.filter((row) => row.originTemplateId === template.id);
    expect(imported).toHaveLength(3);

    // An ordinary Team Resource and an inline prompt keep a null origin.
    await call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/resources`, {
      type: "prompt",
      name: "Ordinary Prompt",
      defaultEnabled: "available",
      payload: { body: "ordinary", description: "d" },
    });
    const withResources = await call(app, admin, "GET", `/api/v1/agents/${agent.uuid}/resources`);
    const current = withResources.json<{
      version: number;
      bindings: Array<Record<string, unknown>>;
      adoptedTemplates: Array<Record<string, unknown>>;
      availableTeamResources: Array<{ originTemplateId: string | null }>;
    }>();
    expect(current.adoptedTemplates).toHaveLength(1);
    const replaced = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
      expectedVersion: current.version,
      bindings: [...current.bindings, { type: "prompt", mode: "include", inlinePromptBody: "inline note" }],
    });
    expect(replaced.statusCode).toBe(200);
    const replacedBody = replaced.json<{
      adoptedTemplates: Array<Record<string, unknown>>;
      effective: { prompts: Array<{ source: string; originTemplateId: string | null }> };
      availableTeamResources: Array<{ name: string; originTemplateId: string | null }>;
    }>();
    // The mutation return path carries the same full projection.
    expect(replacedBody.adoptedTemplates).toHaveLength(1);
    const inlineRow = replacedBody.effective.prompts.find((row) => row.source === "inline_prompt");
    expect(inlineRow?.originTemplateId).toBeNull();
    const ordinary = replacedBody.availableTeamResources.find((row) => row.name === "Ordinary Prompt");
    expect(ordinary?.originTemplateId).toBeNull();
  });

  it("degrades summaries to retired with replacement, then missing after deletion", async () => {
    const app = getApp();
    const publisher = await createPublisherAdmin(app);
    const first = await publishTemplate(app, publisher, `deg-a-${crypto.randomUUID().slice(0, 6)}`, [
      { key: "instructions", type: "prompt", name: "A", payload: { body: "a", description: "d" } },
    ]);
    const second = await publishTemplate(app, publisher, `deg-b-${crypto.randomUUID().slice(0, 6)}`, [
      { key: "instructions", type: "prompt", name: "B", payload: { body: "b", description: "d" } },
    ]);
    const createAgentRow = await seedAgentFactory(app);
    const agent = await createAgentRow({ name: `deg-${crypto.randomUUID().slice(0, 6)}` });
    const admin = await createTestAdmin(app, { username: `dg-${crypto.randomUUID().slice(0, 8)}` });
    await adoptAndRead(app, admin, agent.uuid, [first.id]);

    const retired = await call(app, publisher, "POST", `${INTERNAL_URL}/${first.id}/retire`, {
      expectedUpdatedAt: first.updatedAt,
      replacementTemplateId: second.id,
    });
    expect(retired.statusCode).toBe(200);

    const retiredRead = await call(app, admin, "GET", `/api/v1/agents/${agent.uuid}/resources`);
    const retiredBody = retiredRead.json<{
      adoptedTemplates: Array<{
        status: string;
        replacement: { slug: string; name: string } | null;
        public: { tagline: string } | null;
      }>;
    }>();
    expect(retiredBody.adoptedTemplates[0]?.status).toBe("retired");
    expect(retiredBody.adoptedTemplates[0]?.public?.tagline).toBe("Review-ready PRs");
    expect(retiredBody.adoptedTemplates[0]?.replacement).toEqual({ slug: second.slug, name: second.slug });

    // A damaged outer slug/name degrades the summary to missing without
    // breaking the resources read at all.
    await app.db.update(agentTemplates).set({ slug: "Bad Slug!" }).where(eq(agentTemplates.id, first.id));
    const damagedRead = await call(app, admin, "GET", `/api/v1/agents/${agent.uuid}/resources`);
    expect(damagedRead.statusCode).toBe(200);
    expect(damagedRead.json<{ adoptedTemplates: Array<{ status: string }> }>().adoptedTemplates[0]?.status).toBe(
      "missing",
    );

    await app.db.delete(agentTemplates).where(eq(agentTemplates.id, first.id));
    const missingRead = await call(app, admin, "GET", `/api/v1/agents/${agent.uuid}/resources`);
    const missingBody = missingRead.json<{
      adoptedTemplates: Array<{ status: string; slug: string | null; name: string | null; public: unknown }>;
    }>();
    expect(missingBody.adoptedTemplates[0]).toMatchObject({
      status: "missing",
      slug: null,
      name: null,
      public: null,
      replacement: null,
    });
  });
});

describe("Agent Template projection without publisher config", () => {
  const getApp = useTestApp();

  it("degrades summaries to missing while resources stay readable", async () => {
    const app = getApp();
    const templateId = uuidv7();
    await app.db.insert(agentTemplates).values({
      id: templateId,
      slug: "seeded-template",
      name: "Seeded Template",
      status: "active",
      payload: {
        schemaVersion: 1,
        public: {
          tagline: "t",
          purpose: "p",
          targetUsers: "u",
          userValue: "v",
          instructionsSummary: "i",
          toolsAndSkillsSummary: "s",
        },
        components: [
          {
            key: "instructions",
            type: "prompt",
            name: "Instructions",
            payload: { body: "You are helpful.", description: "d" },
          },
        ],
      },
      createdBy: "qa",
      updatedBy: "qa",
    });
    const createAgentRow = await seedAgentFactory(app);
    const agent = await createAgentRow({ name: `npc-${crypto.randomUUID().slice(0, 6)}` });
    await app.db
      .update(agentConfigs)
      .set({ templateIds: [templateId] })
      .where(eq(agentConfigs.agentId, agent.uuid));
    const admin = await createTestAdmin(app, { username: `np-${crypto.randomUUID().slice(0, 8)}` });

    const reply = await call(app, admin, "GET", `/api/v1/agents/${agent.uuid}/resources`);
    expect(reply.statusCode).toBe(200);
    const body = reply.json<{
      templateIds: string[];
      adoptedTemplates: Array<{ id: string; status: string; slug: string | null }>;
      effective: { prompts: Array<unknown> };
    }>();
    expect(body.templateIds).toEqual([templateId]);
    expect(body.adoptedTemplates).toEqual([
      { id: templateId, status: "missing", slug: null, name: null, public: null, replacement: null },
    ]);
    expect(body.effective.prompts).toBeDefined();
  });
});
