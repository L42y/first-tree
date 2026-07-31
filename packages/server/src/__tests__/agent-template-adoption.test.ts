import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { agents } from "../db/schema/agents.js";
import { attachments } from "../db/schema/attachments.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { resources } from "../db/schema/resources.js";
import { createAgent } from "../services/agent.js";
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
    it("shares one target attachment when two adopted Templates use the same source ZIP", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const bundleId = await uploadZip(app, publisher, skillZip("shared-zip"));
      const first = await publishTemplate(app, publisher, `sh1-${crypto.randomUUID().slice(0, 6)}`, [
        { key: "shared-zip", type: "skill", bundleAttachmentId: bundleId },
      ]);
      const second = await publishTemplate(app, publisher, `sh2-${crypto.randomUUID().slice(0, 6)}`, [
        { key: "shared-zip", type: "skill", bundleAttachmentId: bundleId },
      ]);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `sh-${crypto.randomUUID().slice(0, 6)}` });
      const admin = await createTestAdmin(app, { username: `sh-${crypto.randomUUID().slice(0, 8)}` });
      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));

      const reply = await adopt(app, admin, agent.uuid, config?.version ?? 1, [first.id, second.id]);
      expect(reply.statusCode).toBe(200);
      const rows = [...(await provenanceResources(app, first.id)), ...(await provenanceResources(app, second.id))];
      expect(rows).toHaveLength(2);
      expect(rows[0]?.bundleAttachmentId).toBeTruthy();
      expect(rows[0]?.bundleAttachmentId).toBe(rows[1]?.bundleAttachmentId);
      expect(rows[0]?.bundleAttachmentId).not.toBe(bundleId);
    });

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
