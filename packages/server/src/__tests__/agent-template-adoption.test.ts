import {
  AGENT_STATUSES,
  AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES,
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
} from "@first-tree/shared";
import { and, asc, eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { sslOptions } from "../db/connection.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { agents } from "../db/schema/agents.js";
import { attachments } from "../db/schema/attachments.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { resources } from "../db/schema/resources.js";
import { createAgent } from "../services/agents/identity.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, createTestAgent, seedAgentFactory, useTestApp } from "./helpers.js";

const PUBLISHER_ORG_ID = "agent-template-publisher-org-test";
const INTERNAL_URL = "/api/v1/internal/agent-templates";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;
type TestApp = ReturnType<ReturnType<typeof useTestApp>>;

function skillZip(name: string, entries: Record<string, Uint8Array> = {}): Buffer {
  return Buffer.from(
    zipSync({
      "SKILL.md": strToU8(`---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n\nRun carefully.`),
      ...entries,
    }),
  );
}

async function seedPublisherMembership(
  app: TestApp,
  userId: string,
  role: "admin" | "member",
): Promise<{ memberId: string }> {
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
      userId,
      organizationId: PUBLISHER_ORG_ID,
      agentId: human.uuid,
      role,
    });
  });
  return { memberId };
}

async function createPublisherAdmin(app: TestApp): Promise<Admin> {
  const admin = await createTestAdmin(app, { username: `pub-${crypto.randomUUID().slice(0, 8)}` });
  await seedPublisherMembership(app, admin.userId, "admin");
  return admin;
}

async function uploadZip(app: TestApp, admin: Admin, bytes: Buffer): Promise<string> {
  const reply = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${PUBLISHER_ORG_ID}/attachments`,
    headers: {
      authorization: `Bearer ${admin.accessToken}`,
      "content-type": "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: "application/zip",
      [ATTACHMENT_FILENAME_HEADER]: "skill.zip",
    },
    payload: bytes,
  });
  expect(reply.statusCode).toBe(201);
  return reply.json<{ id: string }>().id;
}

function validPublicProfile() {
  return {
    tagline: "t",
    purpose: "p",
    targetUsers: "u",
    userValue: "v",
    instructionsSummary: "i",
    toolsAndSkillsSummary: "s",
  };
}

function promptComponent(key = "instructions") {
  return {
    key,
    type: "prompt",
    name: `${key} prompt`,
    payload: { body: `You follow ${key}.`, description: "core" },
  };
}

function mcpComponent(key = "github-mcp", name = "github") {
  return {
    key,
    type: "mcp",
    name: `${name} mcp`,
    payload: { name, transport: "http", url: `https://mcp.example/${name}` },
  };
}

async function publishTemplate(
  app: TestApp,
  publisher: Admin,
  slug: string,
  components: unknown[],
): Promise<{ id: string; slug: string; updatedAt: string }> {
  const created = await app.inject({
    method: "POST",
    url: INTERNAL_URL,
    headers: { authorization: `Bearer ${publisher.accessToken}` },
    payload: { slug, name: slug, public: validPublicProfile(), components },
  });
  expect(created.statusCode).toBe(201);
  const draft = created.json<{ id: string; updatedAt: string }>();
  const published = await app.inject({
    method: "POST",
    url: `${INTERNAL_URL}/${draft.id}/publish`,
    headers: { authorization: `Bearer ${publisher.accessToken}` },
    payload: { expectedUpdatedAt: draft.updatedAt },
  });
  expect(published.statusCode).toBe(200);
  return { id: draft.id, slug, updatedAt: published.json<{ updatedAt: string }>().updatedAt };
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

describe("Agent Template adoption", () => {
  const getApp = useTestApp({ agentTemplatePublisherOrgId: PUBLISHER_ORG_ID });

  async function getResources(app: TestApp, admin: Admin, agentUuid: string) {
    const reply = await call(app, admin, "GET", `/api/v1/agents/${agentUuid}/resources`);
    expect(reply.statusCode).toBe(200);
    return reply.json<{
      version: number;
      templateIds: string[];
      bindings: Array<Record<string, unknown>>;
      effective: { mcp: Array<{ name: string }> };
    }>();
  }

  async function adopt(app: TestApp, admin: Admin, agentUuid: string, expectedVersion: number, templateIds: string[]) {
    return call(app, admin, "PATCH", `/api/v1/agents/${agentUuid}/templates`, { expectedVersion, templateIds });
  }

  async function provenanceResources(app: TestApp, templateId: string) {
    return app.db.select().from(resources).where(eq(resources.originTemplateId, templateId));
  }

  describe("permissions and write guards", () => {
    it("still allows a real manager after demotion from org admin", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `mgr-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const manager = await createTestAgent(app, { name: `mgr-agent-${crypto.randomUUID().slice(0, 6)}` });
      await app.db
        .update(members)
        .set({ role: "member" })
        .where(and(eq(members.userId, manager.userId), eq(members.organizationId, manager.organizationId)));
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, manager.agent.uuid));
      const reply = await call(
        app,
        { accessToken: manager.accessToken },
        "PATCH",
        `/api/v1/agents/${manager.agent.uuid}/templates`,
        { expectedVersion: config?.version ?? 1, templateIds: [template.id] },
      );
      expect(reply.statusCode).toBe(200);
    });

    it("allows the manager and an org admin, rejects others", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `perm-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `perm-agent-${crypto.randomUUID().slice(0, 6)}` });

      // The factory admin is not this agent's manager; find the managing admin.
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect(config).toBeDefined();

      const outsider = await createTestAdmin(app, { username: `out-${crypto.randomUUID().slice(0, 8)}` });
      await app.db
        .update(members)
        .set({ role: "member" })
        .where(and(eq(members.userId, outsider.userId), eq(members.organizationId, outsider.organizationId)));
      const denied = await adopt(app, outsider, agent.uuid, config?.version ?? 1, [template.id]);
      expect(denied.statusCode).toBe(404);

      const orgAdmin = await createTestAdmin(app, { username: `adm-${crypto.randomUUID().slice(0, 8)}` });
      const asAdmin = await adopt(app, orgAdmin, agent.uuid, config?.version ?? 1, [template.id]);
      expect(asAdmin.statusCode).toBe(200);
      expect(asAdmin.json<{ version: number }>().version).toBe((config?.version ?? 1) + 1);
    });

    it("rejects Template PATCH on a suspended Agent without mutating state", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `sus-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `sus-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `sus-${crypto.randomUUID().slice(0, 8)}` });
      const [configBefore] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect(configBefore).toBeDefined();

      // Adopt once while active so provenance Resources exist, then suspend.
      // There is no route fast path: this PATCH enters the locked service
      // transaction and is rejected by the held-row active guard.
      expect((await adopt(app, admin, agent.uuid, configBefore?.version ?? 1, [template.id])).statusCode).toBe(200);
      const before = await getResources(app, admin, agent.uuid);
      const [configSnapshot] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      const bindingsBefore = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, agent.uuid))
        .orderBy(asc(agentResourceBindings.id));
      const provenanceBefore = (await provenanceResources(app, template.id)).sort((a, b) => a.id.localeCompare(b.id));

      await app.db.update(agents).set({ status: AGENT_STATUSES.SUSPENDED }).where(eq(agents.uuid, agent.uuid));

      // Same-set / idempotent request must also be rejected by the locked guard.
      const sameSet = await adopt(app, admin, agent.uuid, before.version, before.templateIds);
      expect(sameSet.statusCode).toBe(409);
      expect(sameSet.json<{ code?: string }>().code).toBe(AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.AGENT_INACTIVE);

      const cleared = await adopt(app, admin, agent.uuid, before.version, []);
      expect(cleared.statusCode).toBe(409);
      expect(cleared.json<{ code?: string }>().code).toBe(AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.AGENT_INACTIVE);

      const after = await getResources(app, admin, agent.uuid);
      expect(after.version).toBe(before.version);
      expect(after.templateIds).toEqual(before.templateIds);
      const [configAfter] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect(configAfter).toEqual(configSnapshot);
      const bindingsAfter = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, agent.uuid))
        .orderBy(asc(agentResourceBindings.id));
      expect(bindingsAfter).toEqual(bindingsBefore);
      const provenanceAfter = (await provenanceResources(app, template.id)).sort((a, b) => a.id.localeCompare(b.id));
      expect(provenanceAfter).toEqual(provenanceBefore);
    });

    it("rejects cross-org callers with 404", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `xo-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `xo-agent-${crypto.randomUUID().slice(0, 6)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));

      // A caller whose only membership is in another org.
      const stranger = await createTestAdmin(app, { username: `str-${crypto.randomUUID().slice(0, 8)}` });
      const otherOrgId = `org-other-${crypto.randomUUID().slice(0, 6)}`;
      const otherMemberId = uuidv7();
      await app.db.transaction(async (tx) => {
        await tx.insert(organizations).values({ id: otherOrgId, name: otherOrgId, displayName: "Other Org" });
        const human = await createAgent(tx as unknown as typeof app.db, {
          name: `stranger-human-${crypto.randomUUID().slice(0, 6)}`,
          type: "human",
          displayName: "Stranger",
          managerId: otherMemberId,
          organizationId: otherOrgId,
        });
        await tx.insert(members).values({
          id: otherMemberId,
          userId: stranger.userId,
          organizationId: otherOrgId,
          agentId: human.uuid,
          role: "admin",
        });
        // No active membership left in the agent's org.
        await tx.update(members).set({ status: "left" }).where(eq(members.id, stranger.memberId));
      });
      const reply = await adopt(app, stranger, agent.uuid, config?.version ?? 1, [template.id]);
      expect(reply.statusCode).toBe(404);
    });

    it("rejects Human agents, landing trial agents, and runtime-switch agents", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `guard-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const admin = await createTestAdmin(app, { username: `g-${crypto.randomUUID().slice(0, 8)}` });
      const [humanConfig] = await app.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.agentId, admin.humanAgentUuid));
      const human = await adopt(app, admin, admin.humanAgentUuid, humanConfig?.version ?? 1, [template.id]);
      expect(human.statusCode).toBe(400);

      const createAgentRow = await seedAgentFactory(app);
      const trialAgent = await createAgentRow({ name: `trial-${crypto.randomUUID().slice(0, 6)}` });
      await app.db
        .update(agents)
        .set({
          metadata: { landingCampaignTrial: true, campaign: "production-scan", skillSetId: "s", skillSetVersion: "1" },
        })
        .where(eq(agents.uuid, trialAgent.uuid));
      const trialAdmin = await createTestAdmin(app, { username: `ta-${crypto.randomUUID().slice(0, 8)}` });
      const [trialConfig] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, trialAgent.uuid));
      const trial = await adopt(app, trialAdmin, trialAgent.uuid, trialConfig?.version ?? 1, [template.id]);
      expect(trial.statusCode).toBe(403);

      const switchAgent = await createAgentRow({ name: `switch-${crypto.randomUUID().slice(0, 6)}` });
      await app.db
        .update(agents)
        .set({ metadata: { runtimeSwitch: { claimId: "claim-1" } } })
        .where(eq(agents.uuid, switchAgent.uuid));
      const [switchConfig] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, switchAgent.uuid));
      const switching = await adopt(app, trialAdmin, switchAgent.uuid, switchConfig?.version ?? 1, [template.id]);
      expect(switching.statusCode).toBe(409);
    });
  });

  describe("first import and reuse", () => {
    it("imports prompt, mcp, and a byte-identical skill copy with provenance and bindings", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const zipBytes = skillZip("adopt-skill", { "scripts/run.sh": strToU8("echo ok") });
      const sourceBundle = await uploadZip(app, publisher, zipBytes);
      const template = await publishTemplate(app, publisher, `import-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
        mcpComponent(),
        { key: "adopt-skill", type: "skill", bundleAttachmentId: sourceBundle },
      ]);

      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `import-agent-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `im-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));

      const reply = await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id]);
      expect(reply.statusCode).toBe(200);
      const body = reply.json<{ version: number; templateIds: string[] }>();
      expect(body.version).toBe((config?.version ?? 1) + 1);
      expect(body.templateIds).toEqual([template.id]);

      const rows = await provenanceResources(app, template.id);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.organizationId).toBe(agent.organizationId);
        expect(row.scope).toBe("team");
        expect(row.defaultEnabled).toBe("available");
        expect(row.status).toBe("active");
        expect(row.originTemplateId).toBe(template.id);
        expect(row.originComponentKey).toBeTruthy();
        expect(row.originContentDigest).toMatch(/^[0-9a-f]{64}$/);
      }
      const skillRow = rows.find((row) => row.type === "skill");
      expect(skillRow?.bundleAttachmentId).toBeTruthy();
      expect(skillRow?.bundleAttachmentId).not.toBe(sourceBundle);
      const [copied] = await app.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, skillRow?.bundleAttachmentId ?? ""));
      expect(copied?.organizationId).toBe(agent.organizationId);
      expect(copied?.data?.equals(zipBytes)).toBe(true);
      // The restricted action keeps the caller's audit identity.
      expect(copied?.uploadedBy).toBe(admin.humanAgentUuid);
      for (const row of rows) {
        expect(row.createdBy).toBe(admin.memberId);
        expect(row.updatedBy).toBe(admin.memberId);
      }

      const bindings = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, agent.uuid));
      expect(bindings).toHaveLength(3);
      for (const binding of bindings) {
        expect(binding.mode).toBe("include");
        expect(binding.originTemplateId).toBe(template.id);
        expect(binding.originComponentKey).toBeTruthy();
      }
    });

    it("reuses the Team copy for the second Agent and never re-syncs or revives", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `reuse-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const firstAgent = await createAgentRow({ name: `reuse-a-${crypto.randomUUID().slice(0, 6)}` });
      const secondAgent = await createAgentRow({ name: `reuse-b-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `re-${crypto.randomUUID().slice(0, 8)}` });

      const [configA] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, firstAgent.uuid));
      expect((await adopt(app, admin, firstAgent.uuid, configA?.version ?? 1, [template.id])).statusCode).toBe(200);
      const [imported] = await provenanceResources(app, template.id);

      // The Team customizes its copy afterwards.
      await app.db
        .update(resources)
        .set({ payload: { body: "Team-edited instructions.", description: "edited" } })
        .where(eq(resources.id, imported?.id ?? ""));

      const [configB] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, secondAgent.uuid));
      expect((await adopt(app, admin, secondAgent.uuid, configB?.version ?? 1, [template.id])).statusCode).toBe(200);

      // Still exactly one Team Resource; the second Agent reuses it.
      expect(await provenanceResources(app, template.id)).toHaveLength(1);
      const secondBindings = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, secondAgent.uuid));
      expect(secondBindings).toHaveLength(1);
      expect(secondBindings[0]?.resourceId).toBe(imported?.id);

      // The official Template gains a new component afterwards — the already
      // imported Team does not receive it.
      const detail = await call(app, publisher, "GET", `${INTERNAL_URL}/${template.id}`);
      const current = detail.json<{ updatedAt: string; payload: { components: unknown[] } }>();
      const updated = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${template.id}`, {
        expectedUpdatedAt: current.updatedAt,
        components: [...current.payload.components, promptComponent("extra")],
      });
      expect(updated.statusCode).toBe(200);

      const thirdAgent = await createAgentRow({ name: `reuse-c-${crypto.randomUUID().slice(0, 6)}` });
      const [configC] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, thirdAgent.uuid));
      expect((await adopt(app, admin, thirdAgent.uuid, configC?.version ?? 1, [template.id])).statusCode).toBe(200);
      expect(await provenanceResources(app, template.id)).toHaveLength(1);

      // A retired Team Resource stays retired — adoption does not revive it.
      await app.db
        .update(resources)
        .set({ status: "retired" })
        .where(eq(resources.id, imported?.id ?? ""));
      const fourthAgent = await createAgentRow({ name: `reuse-d-${crypto.randomUUID().slice(0, 6)}` });
      const [configD] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, fourthAgent.uuid));
      expect((await adopt(app, admin, fourthAgent.uuid, configD?.version ?? 1, [template.id])).statusCode).toBe(200);
      expect(
        await app.db.select().from(agentResourceBindings).where(eq(agentResourceBindings.agentId, fourthAgent.uuid)),
      ).toHaveLength(0);
    });

    it("serializes concurrent first imports into one Team copy", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const zipBytes = skillZip("concurrent-skill");
      const bundleId = await uploadZip(app, publisher, zipBytes);
      const template = await publishTemplate(app, publisher, `conc-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
        { key: "concurrent-skill", type: "skill", bundleAttachmentId: bundleId },
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agentA = await createAgentRow({ name: `conc-a-${crypto.randomUUID().slice(0, 6)}` });
      const agentB = await createAgentRow({ name: `conc-b-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `cc-${crypto.randomUUID().slice(0, 8)}` });
      const [configA] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agentA.uuid));
      const [configB] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agentB.uuid));

      const [replyA, replyB] = await Promise.all([
        adopt(app, admin, agentA.uuid, configA?.version ?? 1, [template.id]),
        adopt(app, admin, agentB.uuid, configB?.version ?? 1, [template.id]),
      ]);
      expect(replyA.statusCode).toBe(200);
      expect(replyB.statusCode).toBe(200);
      // Exactly one Team copy — one prompt + one skill Resource, and a
      // single byte-copy attachment behind the skill.
      const rows = await provenanceResources(app, template.id);
      expect(rows).toHaveLength(2);
      const skillRow = rows.find((row) => row.type === "skill");
      expect(skillRow?.bundleAttachmentId).toBeTruthy();
      expect(skillRow?.bundleAttachmentId).not.toBe(bundleId);
      const [copy] = await app.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, skillRow?.bundleAttachmentId ?? ""));
      expect(copy?.data?.equals(zipBytes)).toBe(true);
    });
  });

  describe("replace-set semantics", () => {
    it("is an idempotent no-op for the same set and 409s on stale versions", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `noop-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `noop-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `no-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));

      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);
      const adopted = await getResources(app, admin, agent.uuid);

      const noop = await adopt(app, admin, agent.uuid, adopted.version, [template.id]);
      expect(noop.statusCode).toBe(200);
      expect(noop.json<{ version: number }>().version).toBe(adopted.version);

      const stale = await adopt(app, admin, agent.uuid, (config?.version ?? 1) + 99, [template.id]);
      expect(stale.statusCode).toBe(409);
      expect(stale.json<{ code?: string }>().code).toBe(AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.VERSION_CONFLICT);
    });

    it("removes only auto bindings on removal and keeps manual ones", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `rem-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `rem-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `rm-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);
      const [imported] = await provenanceResources(app, template.id);

      // Turn the auto binding into a manual one by round-tripping with an
      // inline prompt replacement on the same row, then adopt + remove again.
      const withResources = await getResources(app, admin, agent.uuid);
      const manualReply = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
        expectedVersion: withResources.version,
        bindings: [...withResources.bindings, { type: "prompt", mode: "include", inlinePromptBody: "manual note" }],
      });
      expect(manualReply.statusCode).toBe(200);
      const afterManual = await getResources(app, admin, agent.uuid);

      const removed = await adopt(app, admin, agent.uuid, afterManual.version, []);
      expect(removed.statusCode).toBe(200);
      const remaining = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, agent.uuid));
      // Only the manual inline prompt binding survives.
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.inlinePromptBody).toBe("manual note");
      expect(remaining[0]?.originTemplateId).toBeNull();
      // The Team Resource itself is never deleted by adoption removal.
      const [stillThere] = await app.db
        .select()
        .from(resources)
        .where(eq(resources.id, imported?.id ?? ""));
      expect(stillThere).toBeDefined();
    });

    it("does not duplicate a manual include and rejects conflicting disable choices", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `dup-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `dup-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `du-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);
      const [imported] = await provenanceResources(app, template.id);

      // Convert the auto binding to manual by re-adding the same include
      // through the resources API (drops provenance), then remove the
      // Template and re-adopt: no duplicate binding appears.
      const withResources = await getResources(app, admin, agent.uuid);
      const autoBinding = withResources.bindings.find((binding) => binding.resourceId === imported?.id);
      const manual = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
        expectedVersion: withResources.version,
        bindings: [{ type: "prompt", mode: "include", resourceId: imported?.id }],
      });
      expect(manual.statusCode).toBe(200);
      const afterManual = await getResources(app, admin, agent.uuid);
      expect((await adopt(app, admin, agent.uuid, afterManual.version, [])).statusCode).toBe(200);
      const cleared = await getResources(app, admin, agent.uuid);
      const reAdopted = await adopt(app, admin, agent.uuid, cleared.version, [template.id]);
      expect(reAdopted.statusCode).toBe(200);
      const bindingsForResource = await app.db
        .select()
        .from(agentResourceBindings)
        .where(
          and(eq(agentResourceBindings.agentId, agent.uuid), eq(agentResourceBindings.resourceId, imported?.id ?? "")),
        );
      expect(bindingsForResource).toHaveLength(1);
      void autoBinding;

      // A disable choice against the Resource blocks re-adoption with 409.
      const afterReAdopt = await getResources(app, admin, agent.uuid);
      const disabled = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
        expectedVersion: afterReAdopt.version,
        bindings: [{ type: "prompt", mode: "disable", resourceId: imported?.id }],
      });
      expect(disabled.statusCode).toBe(200);
      const afterDisable = await getResources(app, admin, agent.uuid);
      const cleared2 = await adopt(app, admin, agent.uuid, afterDisable.version, []);
      expect(cleared2.statusCode).toBe(200);
      const afterClear = await getResources(app, admin, agent.uuid);
      const conflict = await adopt(app, admin, agent.uuid, afterClear.version, [template.id]);
      expect(conflict.statusCode).toBe(409);
    });

    it("rejects MCP server names that collide case-insensitively", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `mcpc-${crypto.randomUUID().slice(0, 6)}`, [
        mcpComponent("collide-mcp", "github"),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `mcpc-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `mc-${crypto.randomUUID().slice(0, 8)}` });

      // A recommended Team MCP already provides "GitHub" to every Agent.
      await app.db.insert(resources).values({
        id: uuidv7(),
        organizationId: agent.organizationId,
        type: "mcp",
        scope: "team",
        name: "GitHub MCP",
        defaultEnabled: "recommended",
        status: "active",
        payload: { name: "GitHub", transport: "http", url: "https://mcp.example/github" },
        createdBy: "qa",
        updatedBy: "qa",
      });

      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      const conflict = await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id]);
      expect(conflict.statusCode).toBe(409);
    });
  });

  describe("shared bundles, conflicts, and lifecycle edges", () => {
    // Two Templates sharing one source ZIP always declare the same Skill
    // name (the name is derived from that ZIP), so the Team Skill name
    // invariant below rejects that combination instead of importing it — see
    // "rejects duplicate Skill names across Templates inside one adoption".

    it("rejects adoption when a replace binding targets the Resource in either direction", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `rep-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `rep-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `rp-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);
      const [imported] = await provenanceResources(app, template.id);

      // Manual replace that targets the imported Resource.
      const withResources = await getResources(app, admin, agent.uuid);
      const replaced = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
        expectedVersion: withResources.version,
        bindings: [
          { type: "prompt", mode: "replace", replacesResourceId: imported?.id, inlinePromptBody: "manual override" },
        ],
      });
      expect(replaced.statusCode).toBe(200);

      // Removing the Template keeps the manual replace binding; re-adopting
      // must then conflict with it instead of silently overriding.
      const afterReplace = await getResources(app, admin, agent.uuid);
      expect((await adopt(app, admin, agent.uuid, afterReplace.version, [])).statusCode).toBe(200);
      const after = await getResources(app, admin, agent.uuid);
      const conflict = await adopt(app, admin, agent.uuid, after.version, [template.id]);
      expect(conflict.statusCode).toBe(409);
    });

    it("re-adopts cleanly over a manual MCP include without self-conflict or duplicates", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `mcpi-${crypto.randomUUID().slice(0, 6)}`, [
        mcpComponent("manual-mcp", "github"),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `mcpi-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `mi-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);
      const [imported] = await provenanceResources(app, template.id);

      // Remove the Template, then include the Resource manually.
      const afterAdopt = await getResources(app, admin, agent.uuid);
      expect((await adopt(app, admin, agent.uuid, afterAdopt.version, [])).statusCode).toBe(200);
      const afterRemove = await getResources(app, admin, agent.uuid);
      const manual = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
        expectedVersion: afterRemove.version,
        bindings: [{ type: "mcp", mode: "include", resourceId: imported?.id }],
      });
      expect(manual.statusCode).toBe(200);

      const afterManual = await getResources(app, admin, agent.uuid);
      const reAdopted = await adopt(app, admin, agent.uuid, afterManual.version, [template.id]);
      expect(reAdopted.statusCode).toBe(200);
      const rows = await app.db
        .select()
        .from(agentResourceBindings)
        .where(
          and(eq(agentResourceBindings.agentId, agent.uuid), eq(agentResourceBindings.resourceId, imported?.id ?? "")),
        );
      expect(rows).toHaveLength(1);
    });

    it("still conflicts when the same-name MCP is explicitly bound despite a disable row", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `xmd-${crypto.randomUUID().slice(0, 6)}`, [
        mcpComponent("xmd-mcp", "github"),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `xmd-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `xm-${crypto.randomUUID().slice(0, 8)}` });
      const teamMcpId = uuidv7();
      await app.db.insert(resources).values({
        id: teamMcpId,
        organizationId: agent.organizationId,
        type: "mcp",
        scope: "team",
        name: "GitHub MCP",
        defaultEnabled: "available",
        status: "active",
        payload: { name: "GitHub", transport: "http", url: "https://mcp.example/github" },
        createdBy: "qa",
        updatedBy: "qa",
      });

      // The replace-set API allows an include and a disable on the same
      // Resource; the effective projection still keeps the include row
      // enabled, so adoption must conflict, not pass.
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      const manual = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
        expectedVersion: config?.version ?? 1,
        bindings: [
          { type: "mcp", mode: "include", resourceId: teamMcpId },
          { type: "mcp", mode: "disable", resourceId: teamMcpId },
        ],
      });
      expect(manual.statusCode).toBe(200);
      const after = await getResources(app, admin, agent.uuid);
      const conflict = await adopt(app, admin, agent.uuid, after.version, [template.id]);
      expect(conflict.statusCode).toBe(409);
    });

    it("swaps same-name MCP Templates atomically in one replace-set", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const templateA = await publishTemplate(app, publisher, `swa-${crypto.randomUUID().slice(0, 6)}`, [
        mcpComponent("swap-a-mcp", "github"),
      ]);
      const templateB = await publishTemplate(app, publisher, `swb-${crypto.randomUUID().slice(0, 6)}`, [
        mcpComponent("swap-b-mcp", "github"),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `swap-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `sw-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [templateA.id])).statusCode).toBe(200);
      const [resourceA] = await provenanceResources(app, templateA.id);

      const afterA = await getResources(app, admin, agent.uuid);
      const swapped = await adopt(app, admin, agent.uuid, afterA.version, [templateB.id]);
      expect(swapped.statusCode).toBe(200);
      const body = swapped.json<{ version: number; templateIds: string[] }>();
      expect(body.version).toBe(afterA.version + 1);
      expect(body.templateIds).toEqual([templateB.id]);

      const bindings = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, agent.uuid));
      expect(bindings.filter((binding) => binding.resourceId === resourceA?.id)).toHaveLength(0);
      const [resourceB] = await provenanceResources(app, templateB.id);
      expect(bindings.filter((binding) => binding.resourceId === resourceB?.id)).toHaveLength(1);
      expect(bindings.find((binding) => binding.resourceId === resourceB?.id)?.originTemplateId).toBe(templateB.id);
    });

    it("keeps a retired-after-adoption Template in place, removable, but never newly adoptable", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `ret-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `ret-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `rt-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);

      // Retire the Template afterwards.
      const detail = await call(app, publisher, "GET", `${INTERNAL_URL}/${template.id}`);
      const retired = await call(app, publisher, "POST", `${INTERNAL_URL}/${template.id}/retire`, {
        expectedUpdatedAt: detail.json<{ updatedAt: string }>().updatedAt,
      });
      expect(retired.statusCode).toBe(200);

      // Same set is still a no-op; removal still works.
      const afterAdopt = await getResources(app, admin, agent.uuid);
      const noop = await adopt(app, admin, agent.uuid, afterAdopt.version, [template.id]);
      expect(noop.statusCode).toBe(200);
      expect(noop.json<{ version: number }>().version).toBe(afterAdopt.version);
      expect((await adopt(app, admin, agent.uuid, afterAdopt.version, [])).statusCode).toBe(200);

      // A retired Template can never be newly adopted by another Agent.
      const other = await createAgentRow({ name: `ret-b-${crypto.randomUUID().slice(0, 6)}` });
      const [otherConfig] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, other.uuid));
      const reply = await adopt(app, admin, other.uuid, otherConfig?.version ?? 1, [template.id]);
      expect(reply.statusCode).toBe(409);
    });
  });

  describe("Team Skill name invariant", () => {
    async function copiesOf(app: TestApp, admin: Admin): Promise<number> {
      return (
        await app.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(eq(attachments.uploadedBy, admin.humanAgentUuid))
      ).length;
    }

    it("rejects a first-import Skill whose name already exists in the Team, before any copy", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const admin = await createTestAdmin(app, { username: `sn-${crypto.randomUUID().slice(0, 8)}` });

      // The Team already owns an active Skill with this exact name.
      const teamZip = skillZip("adopt-skill");
      const teamBundle = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${admin.organizationId}/attachments`,
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          "content-type": "application/octet-stream",
          [ATTACHMENT_MIME_HEADER]: "application/zip",
          [ATTACHMENT_FILENAME_HEADER]: "skill.zip",
        },
        payload: teamZip,
      });
      expect(teamBundle.statusCode).toBe(201);
      const created = await call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/resources`, {
        type: "skill",
        bundleAttachmentId: teamBundle.json<{ id: string }>().id,
        defaultEnabled: "available",
      });
      expect(created.statusCode).toBe(201);

      const templateBundle = await uploadZip(app, publisher, skillZip("Adopt-Skill"));
      const template = await publishTemplate(app, publisher, `snc-${crypto.randomUUID().slice(0, 6)}`, [
        { key: "adopt-skill", type: "skill", bundleAttachmentId: templateBundle },
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `sn-${crypto.randomUUID().slice(0, 6)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      const copiesBefore = await copiesOf(app, admin);

      const reply = await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id]);
      expect(reply.statusCode).toBe(409);
      expect(reply.json<{ code?: string; error?: string }>().code).toBe(
        AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.ADOPTION_CONFLICT,
      );
      expect(reply.json<{ error?: string }>().error).toMatch(/already exists/i);
      // The name check runs before Phase 3: nothing was copied.
      expect(await copiesOf(app, admin)).toBe(copiesBefore);
      expect(await provenanceResources(app, template.id)).toHaveLength(0);
    });

    it("rejects duplicate Skill names across Templates inside one adoption", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const bundleA = await uploadZip(app, publisher, skillZip("dup-skill"));
      const bundleB = await uploadZip(app, publisher, skillZip("Dup-Skill"));
      const first = await publishTemplate(app, publisher, `sd1-${crypto.randomUUID().slice(0, 6)}`, [
        { key: "dup-skill", type: "skill", bundleAttachmentId: bundleA },
      ]);
      const second = await publishTemplate(app, publisher, `sd2-${crypto.randomUUID().slice(0, 6)}`, [
        { key: "dup-skill", type: "skill", bundleAttachmentId: bundleB },
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `sd-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `sd-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      const copiesBefore = await copiesOf(app, admin);

      const reply = await adopt(app, admin, agent.uuid, config?.version ?? 1, [first.id, second.id]);
      expect(reply.statusCode).toBe(409);
      expect(await copiesOf(app, admin)).toBe(copiesBefore);
    });
  });

  describe("lock ordering with ordinary Team Skill writes", () => {
    it("never deadlocks adoption against a recommended Team Skill create", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `lo-${crypto.randomUUID().slice(0, 6)}`, [
        {
          key: "lock-skill",
          type: "skill",
          bundleAttachmentId: await uploadZip(app, publisher, skillZip("lock-skill")),
        },
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `lo-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `lo-${crypto.randomUUID().slice(0, 8)}` });

      // The Team's own ready bundle for the ordinary recommended create.
      const teamUpload = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${admin.organizationId}/attachments`,
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          "content-type": "application/octet-stream",
          [ATTACHMENT_MIME_HEADER]: "application/zip",
          [ATTACHMENT_FILENAME_HEADER]: "skill.zip",
        },
        payload: skillZip("team-skill"),
      });
      expect(teamUpload.statusCode).toBe(201);
      const teamBundleId = teamUpload.json<{ id: string }>().id;
      const adoptionCopiesBefore = (
        await app.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(eq(attachments.uploadedBy, admin.humanAgentUuid))
      ).length;

      const [configBefore] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      const url = process.env.DATABASE_URL ?? "";
      const blocker = postgres(url, { max: 1, ...sslOptions(url) });
      const probe = postgres(url, { max: 1, ...sslOptions(url) });
      let ordinaryReply: Awaited<ReturnType<typeof call>> | undefined;
      let adoptionReply: Awaited<ReturnType<typeof call>> | undefined;
      let ordinaryPromise: ReturnType<typeof call> | undefined;
      let adoptionPromise: ReturnType<typeof call> | undefined;
      const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} timed out — possible deadlock`)), 15_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      let blockerInTransaction = false;
      try {
        await blocker`BEGIN`;
        blockerInTransaction = true;
        await blocker`SELECT id FROM attachments WHERE id = ${teamBundleId} FOR UPDATE`;

        ordinaryPromise = call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/resources`, {
          type: "skill",
          bundleAttachmentId: teamBundleId,
          defaultEnabled: "recommended",
        });

        // Wait until the ordinary write provably holds team_skill_name
        // (autocommit probe statements release immediately when the try succeeds).
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [row] =
            await probe`SELECT pg_try_advisory_xact_lock(hashtext('team_skill_name'), hashtext(${admin.organizationId})) AS acquired`;
          if (!row?.acquired) break;
          if (Date.now() > deadline) throw new Error("ordinary write did not take the advisory lock in time");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        adoptionPromise = call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/templates`, {
          expectedVersion: configBefore?.version ?? 1,
          templateIds: [template.id],
        });
        // Wait until the adoption provably waits on the same two-key
        // advisory lock, then unblock the ordinary write.
        const adoptionDeadline = Date.now() + 10_000;
        for (;;) {
          const [row] = await probe`SELECT count(*)::int AS waiters FROM pg_locks
            WHERE locktype = 'advisory' AND objsubid = 2 AND NOT granted
              AND classid::bigint = (hashtext('team_skill_name')::bigint & 4294967295)
              AND objid::bigint = (hashtext(${admin.organizationId})::bigint & 4294967295)`;
          if (row && row.waiters > 0) break;
          if (Date.now() > adoptionDeadline) throw new Error("adoption did not reach the advisory lock wait in time");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await blocker`ROLLBACK`;
        blockerInTransaction = false;

        ordinaryReply = await withTimeout(ordinaryPromise, "ordinary Team Skill create");
        adoptionReply = await withTimeout(adoptionPromise, "Template adoption");
      } finally {
        if (blockerInTransaction) await blocker`ROLLBACK`.catch(() => undefined);
        // Both HTTP promises must converge even on error paths — no
        // unhandled rejections or dangling work past the test.
        await Promise.allSettled([ordinaryPromise, adoptionPromise].filter((promise) => promise !== undefined));
        await blocker.end({ timeout: 1 }).catch(() => undefined);
        await probe.end({ timeout: 1 }).catch(() => undefined);
      }

      expect(ordinaryReply?.statusCode).toBe(201);
      expect(adoptionReply?.statusCode).toBe(409);

      // Only the ordinary bump landed; the adoption left nothing behind.
      const [configAfter] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect(configAfter?.version).toBe((configBefore?.version ?? 1) + 1);
      expect(configAfter?.templateIds).toEqual([]);
      expect(await provenanceResources(app, template.id)).toHaveLength(0);
      expect(
        (
          await app.db
            .select({ id: attachments.id })
            .from(attachments)
            .where(eq(attachments.uploadedBy, admin.humanAgentUuid))
        ).length,
      ).toBe(adoptionCopiesBefore);
      expect(
        await app.db.select().from(agentResourceBindings).where(eq(agentResourceBindings.agentId, agent.uuid)),
      ).toHaveLength(0);
    });

    it("never deadlocks an existing-agent adoption against Template-backed creation", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const bundleId = await uploadZip(app, publisher, skillZip("dual-entry-skill"));
      const template = await publishTemplate(app, publisher, `de-${crypto.randomUUID().slice(0, 6)}`, [
        { key: "dual-entry-skill", type: "skill", bundleAttachmentId: bundleId },
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const existingAgent = await createAgentRow({ name: `de-old-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `de-${crypto.randomUUID().slice(0, 8)}` });
      const [configBefore] = await app.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.agentId, existingAgent.uuid));

      const url = process.env.DATABASE_URL ?? "";
      const blocker = postgres(url, { max: 1, ...sslOptions(url) });
      const probe = postgres(url, { max: 1, ...sslOptions(url) });
      let patchReply: Awaited<ReturnType<typeof call>> | undefined;
      let postReply: Awaited<ReturnType<typeof call>> | undefined;
      let patchPromise: ReturnType<typeof call> | undefined;
      let postPromise: ReturnType<typeof call> | undefined;
      let blockerInTransaction = false;
      const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} timed out — possible deadlock`)), 15_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const waitForSkillWaiters = async (expected: number, deadline: number, label: string): Promise<void> => {
        for (;;) {
          const [row] = await probe`SELECT count(*)::int AS waiters FROM pg_locks
            WHERE locktype = 'advisory' AND objsubid = 2 AND NOT granted
              AND classid::bigint = (hashtext('team_skill_name')::bigint & 4294967295)
              AND objid::bigint = (hashtext(${admin.organizationId})::bigint & 4294967295)`;
          if (row && row.waiters >= expected) return;
          if (Date.now() > deadline) throw new Error(`${label} did not reach ${expected} waiter(s) in time`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      try {
        await blocker`BEGIN`;
        await blocker`SELECT pg_advisory_xact_lock(hashtext('team_skill_name'), hashtext(${admin.organizationId}))`;
        blockerInTransaction = true;

        patchPromise = call(app, admin, "PATCH", `/api/v1/agents/${existingAgent.uuid}/templates`, {
          expectedVersion: configBefore?.version ?? 1,
          templateIds: [template.id],
        });
        await waitForSkillWaiters(1, Date.now() + 10_000, "existing-agent adoption");

        const newName = `de-new-${crypto.randomUUID().slice(0, 6)}`;
        postPromise = call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/agents`, {
          name: newName,
          displayName: "Dual Entry",
          type: "agent",
          templateIds: [template.id],
        });
        await waitForSkillWaiters(2, Date.now() + 10_000, "Template-backed create");

        // Both entries are parked behind the Team Skill lock, so neither
        // may hold the Team+Template advisory yet.
        const [lockRow] = await probe`SELECT count(*)::int AS granted_count FROM pg_locks
          WHERE locktype = 'advisory' AND objsubid = 2 AND granted
            AND classid::bigint = (hashtext(${admin.organizationId})::bigint & 4294967295)
            AND objid::bigint = (hashtext(${template.id})::bigint & 4294967295)`;
        expect(lockRow?.granted_count).toBe(0);

        await blocker`ROLLBACK`;
        blockerInTransaction = false;

        patchReply = await withTimeout(patchPromise, "existing-agent adoption");
        postReply = await withTimeout(postPromise, "Template-backed create");
      } finally {
        if (blockerInTransaction) await blocker`ROLLBACK`.catch(() => undefined);
        await Promise.allSettled([patchPromise, postPromise].filter((promise) => promise !== undefined));
        await blocker.end({ timeout: 1 }).catch(() => undefined);
        await probe.end({ timeout: 1 }).catch(() => undefined);
      }

      expect(patchReply?.statusCode).toBe(200);
      expect(postReply?.statusCode).toBe(201);

      // One Team copy; both Agents bound to it; config versions exact.
      const rows = await provenanceResources(app, template.id);
      expect(rows).toHaveLength(1);
      // Exactly one byte copy behind the single Skill Resource.
      const copies = await app.db
        .select()
        .from(attachments)
        .where(
          and(eq(attachments.organizationId, admin.organizationId), eq(attachments.uploadedBy, admin.humanAgentUuid)),
        );
      expect(copies).toHaveLength(1);
      expect(rows[0]?.bundleAttachmentId).toBe(copies[0]?.id);
      const created = postReply?.json<{ uuid: string }>();
      const existingBindings = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, existingAgent.uuid));
      expect(existingBindings.map((binding) => binding.resourceId)).toEqual([rows[0]?.id]);
      const newBindings = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, created?.uuid ?? ""));
      expect(newBindings.map((binding) => binding.resourceId)).toEqual([rows[0]?.id]);

      const [configAfter] = await app.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.agentId, existingAgent.uuid));
      expect(configAfter?.version).toBe((configBefore?.version ?? 1) + 1);
      expect(configAfter?.templateIds).toEqual([template.id]);
      const [newConfig] = await app.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.agentId, created?.uuid ?? ""));
      expect(newConfig?.version).toBe(1);
      expect(newConfig?.templateIds).toEqual([template.id]);
    });
  });

  describe("MCP durable name uniqueness", () => {
    async function expectBothMcpUnavailable(app: TestApp, agentUuid: string) {
      const effective = await app.resourcesService.resolveEffectiveResources(agentUuid);
      const enabledNames = effective.mcp.filter((row) => row.mode === "enabled");
      expect(enabledNames).toHaveLength(0);
      const unavailableRows = effective.mcp.filter((row) => row.mode === "unavailable");
      expect(unavailableRows.length).toBeGreaterThanOrEqual(2);
      for (const row of unavailableRows) expect(row.unavailableReason).toBe("duplicate_mcp_name");
      const reasons = effective.unavailable.filter((entry) => entry.type === "mcp").map((entry) => entry.reason);
      expect(reasons.length).toBeGreaterThanOrEqual(2);
      for (const reason of reasons) expect(reason).toBe("duplicate_mcp_name");

      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agentUuid));
      if (!config) throw new Error("agent config missing");
      const resolved = await app.resourcesService.resolveRuntimeConfig({
        agentId: agentUuid,
        version: config.version,
        payload: config.payload,
        updatedAt: config.updatedAt.toISOString(),
        updatedBy: config.updatedBy,
      });
      const projected = resolved.payload.mcpServers.map((server) =>
        typeof server.name === "string" ? server.name.toLowerCase() : "",
      );
      expect(projected).not.toContain("github");
    }

    it("marks both rows unavailable when Team maintenance adds a same-name recommended MCP", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `mdu-${crypto.randomUUID().slice(0, 6)}`, [
        mcpComponent("mdu-mcp", "github"),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `mdu-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `md-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);

      const created = await call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/resources`, {
        type: "mcp",
        name: "GitHub Team MCP",
        defaultEnabled: "recommended",
        payload: { name: "GitHub", transport: "http", url: "https://mcp.example/github" },
      });
      expect(created.statusCode).toBe(201);
      await expectBothMcpUnavailable(app, agent.uuid);
    });

    it("marks both rows unavailable when Team maintenance renames an MCP payload to a collision", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `mup-${crypto.randomUUID().slice(0, 6)}`, [
        mcpComponent("mup-mcp", "github"),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `mup-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `mu-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);

      const other = await call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/resources`, {
        type: "mcp",
        name: "Other MCP",
        defaultEnabled: "available",
        payload: { name: "other", transport: "http", url: "https://mcp.example/other" },
      });
      expect(other.statusCode).toBe(201);
      const updated = await call(app, admin, "PATCH", `/api/v1/resources/${other.json<{ id: string }>().id}`, {
        payload: { name: "GitHub", transport: "http", url: "https://mcp.example/other" },
        defaultEnabled: "recommended",
      });
      expect(updated.statusCode).toBe(200);
      await expectBothMcpUnavailable(app, agent.uuid);
    });
  });

  describe("creation with templates", () => {
    it("creates the Agent, imports, and binds atomically at version 1", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const zipBytes = skillZip("create-skill");
      const bundleId = await uploadZip(app, publisher, zipBytes);
      const template = await publishTemplate(app, publisher, `create-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
        { key: "create-skill", type: "skill", bundleAttachmentId: bundleId },
      ]);
      const admin = await createTestAdmin(app, { username: `cr-${crypto.randomUUID().slice(0, 8)}` });
      const name = `create-agent-${crypto.randomUUID().slice(0, 6)}`;

      const reply = await call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/agents`, {
        name,
        displayName: "Created With Template",
        type: "agent",
        templateIds: [template.id],
      });
      expect(reply.statusCode).toBe(201);
      const created = reply.json<{ uuid: string }>();

      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, created.uuid));
      expect(config?.version).toBe(1);
      expect(config?.templateIds).toEqual([template.id]);
      const imported = await provenanceResources(app, template.id);
      expect(imported).toHaveLength(2);
      const skillRow = imported.find((row) => row.type === "skill");
      const [copied] = await app.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, skillRow?.bundleAttachmentId ?? ""));
      expect(copied?.uploadedBy).toBe(admin.humanAgentUuid);
      for (const row of imported) {
        expect(row.createdBy).toBe(admin.memberId);
        expect(row.updatedBy).toBe(admin.memberId);
      }
      const bindings = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, created.uuid));
      expect(bindings).toHaveLength(2);
      for (const binding of bindings) {
        expect(binding.originTemplateId).toBe(template.id);
        expect(binding.createdBy).toBe(admin.memberId);
      }
    });

    it("leaves zero residue when the adoption fails mid-create", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `resid-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const admin = await createTestAdmin(app, { username: `rs-${crypto.randomUUID().slice(0, 8)}` });
      const name = `residue-${crypto.randomUUID().slice(0, 6)}`;
      const missingTemplateId = crypto.randomUUID();
      const copiesBefore = (
        await app.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(eq(attachments.uploadedBy, "system:agent-template-import"))
      ).length;

      const reply = await call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/agents`, {
        name,
        displayName: "Residue Check",
        type: "agent",
        templateIds: [template.id, missingTemplateId],
      });
      expect([400, 404, 409]).toContain(reply.statusCode);

      const agentRows = await app.db.select().from(agents).where(eq(agents.name, name));
      expect(agentRows).toHaveLength(0);
      expect(await provenanceResources(app, template.id)).toHaveLength(0);
      // The failed adoption produced no new byte copies.
      const copiesAfter = (
        await app.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(eq(attachments.uploadedBy, "system:agent-template-import"))
      ).length;
      expect(copiesAfter).toBe(copiesBefore);

      // A plain create without templates is unaffected.
      const plain = await call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/agents`, {
        name,
        displayName: "Residue Check",
        type: "agent",
      });
      expect(plain.statusCode).toBe(201);
    });

    it("rolls back the Skill copy and imports when the MCP name guard fails after import", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const bundleId = await uploadZip(app, publisher, skillZip("rollback-skill"));
      // The Template carries a real Skill ZIP and an MCP whose name is
      // already effective for the new Agent through a recommended Team MCP —
      // so the copy and the Resource import happen before the guard fails.
      const template = await publishTemplate(app, publisher, `rb-${crypto.randomUUID().slice(0, 6)}`, [
        { key: "rollback-skill", type: "skill", bundleAttachmentId: bundleId },
        mcpComponent("rollback-mcp", "github"),
      ]);
      const admin = await createTestAdmin(app, { username: `rb-${crypto.randomUUID().slice(0, 8)}` });
      await app.db.insert(resources).values({
        id: uuidv7(),
        organizationId: admin.organizationId,
        type: "mcp",
        scope: "team",
        name: "GitHub MCP",
        defaultEnabled: "recommended",
        status: "active",
        payload: { name: "GitHub", transport: "http", url: "https://mcp.example/github" },
        createdBy: "qa",
        updatedBy: "qa",
      });
      const name = `rollback-${crypto.randomUUID().slice(0, 6)}`;
      const agentsBefore = (await app.db.select({ uuid: agents.uuid }).from(agents)).length;
      const configsBefore = (await app.db.select({ agentId: agentConfigs.agentId }).from(agentConfigs)).length;
      const copiesBefore = (
        await app.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(eq(attachments.uploadedBy, admin.humanAgentUuid))
      ).length;

      const reply = await call(app, admin, "POST", `/api/v1/orgs/${admin.organizationId}/agents`, {
        name,
        displayName: "Rollback Check",
        type: "agent",
        templateIds: [template.id],
      });
      expect(reply.statusCode).toBe(409);

      // The whole creation transaction rolled back: no Agent, no config, no
      // delegate, no imported Resources, no byte copy, no bindings.
      expect((await app.db.select({ uuid: agents.uuid }).from(agents)).length).toBe(agentsBefore);
      expect((await app.db.select({ agentId: agentConfigs.agentId }).from(agentConfigs)).length).toBe(configsBefore);
      const [human] = await app.db.select().from(agents).where(eq(agents.uuid, admin.humanAgentUuid));
      expect(human?.delegateMention).toBeNull();
      expect(await provenanceResources(app, template.id)).toHaveLength(0);
      const copiesAfter = (
        await app.db
          .select({ id: attachments.id })
          .from(attachments)
          .where(eq(attachments.uploadedBy, admin.humanAgentUuid))
      ).length;
      expect(copiesAfter).toBe(copiesBefore);
      const bindings = await app.db.select().from(agentResourceBindings);
      expect(bindings.filter((binding) => binding.originTemplateId === template.id)).toHaveLength(0);
    });
  });

  describe("resources round-trip provenance", () => {
    it("keeps provenance for unchanged rows and clears it on semantic changes", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `rt-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `rt-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `rt-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);

      // Unchanged round-trip: provenance survives.
      const first = await getResources(app, admin, agent.uuid);
      const roundTrip = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
        expectedVersion: first.version,
        bindings: first.bindings,
      });
      expect(roundTrip.statusCode).toBe(200);
      let rows = await app.db.select().from(agentResourceBindings).where(eq(agentResourceBindings.agentId, agent.uuid));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.originTemplateId).toBe(template.id);

      // Semantic change: the row becomes manual with cleared provenance.
      const second = await getResources(app, admin, agent.uuid);
      const changed = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
        expectedVersion: second.version,
        bindings: second.bindings.map((binding) => ({
          ...binding,
          inlinePromptBody: "edited inline",
          resourceId: null,
        })),
      });
      expect(changed.statusCode).toBe(200);
      rows = await app.db.select().from(agentResourceBindings).where(eq(agentResourceBindings.agentId, agent.uuid));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.originTemplateId).toBeNull();
      expect(rows[0]?.inlinePromptBody).toBe("edited inline");
    });

    it("treats a pure reorder as a semantic change and protects the row from Template removal", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const template = await publishTemplate(app, publisher, `ord-${crypto.randomUUID().slice(0, 6)}`, [
        promptComponent(),
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `ord-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `or-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect((await adopt(app, admin, agent.uuid, config?.version ?? 1, [template.id])).statusCode).toBe(200);

      const first = await getResources(app, admin, agent.uuid);
      const reordered = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/resources`, {
        expectedVersion: first.version,
        bindings: first.bindings.map((binding) => ({ ...binding, order: 99 })),
      });
      expect(reordered.statusCode).toBe(200);
      const rows = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, agent.uuid));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.originTemplateId).toBeNull();

      const after = await getResources(app, admin, agent.uuid);
      expect((await adopt(app, admin, agent.uuid, after.version, [])).statusCode).toBe(200);
      const remaining = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, agent.uuid));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.order).toBe(99);
    });
  });
});

describe("Agent Template adoption without publisher config", () => {
  const getApp = useTestApp();

  it("rejects adoption of even a prompt-only Template with zero writes", async () => {
    const app = getApp();
    const templateId = uuidv7();
    await app.db.insert(agentTemplates).values({
      id: templateId,
      slug: "prompt-only-template",
      name: "Prompt Only",
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
    const admin = await createTestAdmin(app, { username: `np-${crypto.randomUUID().slice(0, 8)}` });
    const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));

    const reply = await call(app, admin, "PATCH", `/api/v1/agents/${agent.uuid}/templates`, {
      expectedVersion: config?.version ?? 1,
      templateIds: [templateId],
    });
    expect(reply.statusCode).toBe(403);
    const [after] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
    expect(after?.templateIds).toEqual([]);
    expect(after?.version).toBe(config?.version);
    expect(await app.db.select().from(resources).where(eq(resources.originTemplateId, templateId))).toHaveLength(0);
    expect(
      await app.db.select().from(agentResourceBindings).where(eq(agentResourceBindings.agentId, agent.uuid)),
    ).toHaveLength(0);
  });
});
