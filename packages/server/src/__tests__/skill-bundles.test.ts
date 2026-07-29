import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { attachments } from "../db/schema/attachments.js";
import { organizations } from "../db/schema/organizations.js";
import { resources } from "../db/schema/resources.js";
import { sweepOrphanAttachments } from "../services/attachment.js";
import { ensureMembership } from "../services/membership.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedAgentFactory, useTestApp } from "./helpers.js";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

function skillZip(name: string, entries: Record<string, Uint8Array> = {}, wrapper = ""): Buffer {
  const prefix = wrapper ? `${wrapper}/` : "";
  const markdown = `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  owner: platform\n---\n\n# ${name}\n\nRun carefully.`;
  return Buffer.from(
    zipSync({
      [`${prefix}SKILL.md`]: strToU8(markdown),
      ...entries,
    }),
  );
}

async function upload(app: FastifyInstance, admin: Admin, bytes: Buffer, organizationId = admin.organizationId) {
  const reply = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${organizationId}/attachments`,
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

async function createSkill(
  app: FastifyInstance,
  admin: Admin,
  bundleAttachmentId: string,
  defaultEnabled: "available" | "recommended" = "available",
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${admin.organizationId}/resources`,
    headers: { authorization: `Bearer ${admin.accessToken}` },
    payload: { type: "skill", bundleAttachmentId, defaultEnabled },
  });
}

describe("Team Skill bundles", () => {
  const getApp = useTestApp();

  it("creates a Skill from a wrapped complete directory and derives its projection", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(
      app,
      admin,
      skillZip("release-notes", { "release-notes/scripts/run.sh": strToU8("echo ok") }, "release-notes"),
    );

    const reply = await createSkill(app, admin, bundleId);
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({
      type: "skill",
      name: "release-notes",
      bundleAttachmentId: bundleId,
      payload: {
        name: "release-notes",
        description: "release-notes description",
        body: "# release-notes\n\nRun carefully.",
        metadata: { owner: "platform" },
      },
    });
  });

  it("atomically replaces a bundle, bumps impacted configs, and removes the old object", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const createAgent = await seedAgentFactory(app);
    const agent = await createAgent({ name: `bundle-agent-${crypto.randomUUID().slice(0, 6)}` });
    const oldBundleId = await upload(app, admin, skillZip("reviewer"));
    const created = await createSkill(app, admin, oldBundleId, "recommended");
    expect(created.statusCode).toBe(201);
    const resource = created.json<{ id: string }>();
    const [before] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid));

    const newBundleId = await upload(app, admin, skillZip("reviewer-next"));
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/resources/${resource.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { bundleAttachmentId: newBundleId },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: resource.id,
      name: "reviewer-next",
      bundleAttachmentId: newBundleId,
    });

    const [after] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid));
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, oldBundleId))).toHaveLength(0);
  });

  it("rejects cross-organization, reserved-name, and unsafe-path bundles", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const otherOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: otherOrgId, name: otherOrgId.slice(0, 30), displayName: "Other team" });
    await ensureMembership(app.db, {
      userId: admin.userId,
      organizationId: otherOrgId,
      role: "member",
      displayName: "Other uploader",
      username: admin.username,
    });

    const foreign = await upload(app, admin, skillZip("foreign"), otherOrgId);
    expect((await createSkill(app, admin, foreign)).statusCode).toBe(400);

    const reserved = await upload(app, admin, skillZip("first-tree-write"));
    expect((await createSkill(app, admin, reserved)).statusCode).toBe(400);

    const unsafe = await upload(
      app,
      admin,
      Buffer.from(zipSync({ "../SKILL.md": strToU8("---\nname: unsafe\ndescription: unsafe\n---\n") })),
    );
    expect((await createSkill(app, admin, unsafe)).statusCode).toBe(400);
  });

  it("keeps an uploaded bundle orphaned on validation failure and sweeps it after 24 hours", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(app, admin, skillZip("first-tree-read"));
    expect((await createSkill(app, admin, bundleId)).statusCode).toBe(400);

    await app.db
      .update(attachments)
      .set({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) })
      .where(eq(attachments.id, bundleId));
    const result = await sweepOrphanAttachments(app.db);
    expect(result.deleted).toBe(1);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, bundleId))).toHaveLength(0);
  });

  it("keeps referenced bundles and advances their bounded sweep timestamp", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(app, admin, skillZip("referenced"));
    expect((await createSkill(app, admin, bundleId)).statusCode).toBe(201);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await app.db.update(attachments).set({ updatedAt: stale }).where(eq(attachments.id, bundleId));

    const result = await sweepOrphanAttachments(app.db);
    const [stored] = await app.db
      .select({ updatedAt: attachments.updatedAt })
      .from(attachments)
      .where(eq(attachments.id, bundleId));
    expect(result.deleted).toBe(0);
    expect(stored?.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("rejects duplicate active Team Skill names and independent payload edits", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const firstBundle = await upload(app, admin, skillZip("dedupe"));
    const created = await createSkill(app, admin, firstBundle);
    expect(created.statusCode).toBe(201);
    const resourceId = created.json<{ id: string }>().id;

    const duplicateBundle = await upload(app, admin, skillZip("dedupe"));
    expect((await createSkill(app, admin, duplicateBundle)).statusCode).toBe(409);
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/v1/resources/${resourceId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { name: "manual-name", payload: { body: "manual" } },
    });
    expect(edit.statusCode).toBe(400);

    const [stored] = await app.db.select().from(resources).where(eq(resources.id, resourceId));
    expect(stored?.name).toBe("dedupe");
  });
});
