import type { AgentTemplatePayload } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { attachments } from "../db/schema/attachments.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { resources } from "../db/schema/resources.js";
import {
  createAttachment,
  loadAttachmentMetaForReference,
  MESSAGE_ATTACHMENT_RETENTION_MS,
  sweepExpiredMessageAttachments,
} from "../services/attachment.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type TestApp = FastifyInstance;
type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

const TEST_QUOTA = { maxOrganizationAttachments: 10_000 };
const EXPIRED_AGE_MS = MESSAGE_ATTACHMENT_RETENTION_MS + 24 * 60 * 60 * 1_000;

async function createAgedAttachment(app: TestApp, admin: Admin, ageMs: number, filename = "aged.bin") {
  const row = await createAttachment(
    app.db,
    {
      organizationId: admin.organizationId,
      mimeType: "application/octet-stream",
      filename,
      body: Buffer.from(`bytes-of-${filename}`),
      uploadedBy: admin.humanAgentUuid,
    },
    TEST_QUOTA,
  );
  await app.db
    .update(attachments)
    .set({ createdAt: new Date(Date.now() - ageMs) })
    .where(eq(attachments.id, row.id));
  return row;
}

async function addMessageReference(app: TestApp, admin: Admin, attachmentId: string): Promise<void> {
  const chatId = uuidv7();
  await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
  await app.db.insert(messages).values({
    id: uuidv7(),
    chatId,
    senderId: admin.humanAgentUuid,
    format: "markdown",
    content: "message referencing the attachment",
    metadata: {
      attachments: [
        {
          attachmentId,
          kind: "document",
          mimeType: "application/octet-stream",
          filename: "aged.bin",
          size: 10,
          sha256: "a".repeat(64),
          source: { path: "aged.bin" },
        },
      ],
    },
    source: "api",
  });
}

async function addResourceReference(app: TestApp, admin: Admin, attachmentId: string): Promise<string> {
  const resourceId = uuidv7();
  await app.db.insert(resources).values({
    id: resourceId,
    organizationId: admin.organizationId,
    type: "skill",
    scope: "team",
    name: `retention-guard-${resourceId.slice(0, 8)}`,
    bundleAttachmentId: attachmentId,
    payload: { name: "retention-guard", description: "d", body: "# guard", metadata: {} },
    createdBy: admin.memberId,
    updatedBy: admin.memberId,
  });
  return resourceId;
}

describe("message attachment retention sweep", () => {
  const getApp = useTestApp();

  it("dry-run counts expired message attachments without deleting them", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `ret-dry-${crypto.randomUUID().slice(0, 6)}` });
    const expired = await createAgedAttachment(app, admin, EXPIRED_AGE_MS, "expired.bin");
    await createAgedAttachment(app, admin, MESSAGE_ATTACHMENT_RETENTION_MS - 60 * 60 * 1_000, "fresh-enough.bin");
    await addMessageReference(app, admin, expired.id);

    const result = await sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, { deleteEnabled: false });

    expect(result).toEqual({
      eligibleObjects: 1,
      eligibleBytes: expired.sizeBytes,
      deleted: 0,
      reclaimedBytes: 0,
      batches: 0,
    });
    expect(await app.db.select().from(attachments).where(eq(attachments.id, expired.id))).toHaveLength(1);
  });

  it("deletes expired rows even while a historical message still references them", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `ret-del-${crypto.randomUUID().slice(0, 6)}` });
    const expired = await createAgedAttachment(app, admin, EXPIRED_AGE_MS);
    await addMessageReference(app, admin, expired.id);

    const result = await sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, { deleteEnabled: true });

    expect(result.deleted).toBe(1);
    expect(result.reclaimedBytes).toBe(expired.sizeBytes);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, expired.id))).toHaveLength(0);
    // Messages are immutable: the referencing row stays put with its metadata.
    expect(await app.db.select().from(messages).where(eq(messages.senderId, admin.humanAgentUuid))).toHaveLength(1);
  });

  it("keeps rows protected by a Team Skill Resource and reclaims them after release", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `ret-res-${crypto.randomUUID().slice(0, 6)}` });
    const bundle = await createAgedAttachment(app, admin, EXPIRED_AGE_MS, "skill-bundle.zip");
    const resourceId = await addResourceReference(app, admin, bundle.id);

    const protectedRun = await sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, {
      deleteEnabled: true,
    });
    expect(protectedRun.deleted).toBe(0);
    expect(protectedRun.eligibleObjects).toBe(0);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, bundle.id))).toHaveLength(1);

    // Once the last bundle reference is released the row expires normally.
    await app.db.delete(resources).where(eq(resources.id, resourceId));
    const releasedRun = await sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, { deleteEnabled: true });
    expect(releasedRun.deleted).toBe(1);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, bundle.id))).toHaveLength(0);
  });

  it("keeps rows referenced only by an Agent Template bundle", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `ret-tpl-${crypto.randomUUID().slice(0, 6)}` });
    const bundle = await createAgedAttachment(app, admin, EXPIRED_AGE_MS, "template-bundle.zip");
    const payload: AgentTemplatePayload = {
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
          key: "guarded-skill",
          type: "skill",
          name: "Guarded Skill",
          payload: { name: "guarded-skill", description: "d", body: "# guarded\n", metadata: {} },
          bundle: { attachmentId: bundle.id, format: "zip", sizeBytes: bundle.sizeBytes },
        },
      ],
    };
    await app.db.insert(agentTemplates).values({
      id: uuidv7(),
      slug: `guarded-${crypto.randomUUID().slice(0, 8)}`,
      name: "Guarded",
      status: "active",
      payload,
      createdBy: "qa",
      updatedBy: "qa",
    });

    const result = await sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, { deleteEnabled: true });

    expect(result.deleted).toBe(0);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, bundle.id))).toHaveLength(1);
  });

  it("reclaims organization quota once expired rows are deleted", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `ret-quota-${crypto.randomUUID().slice(0, 6)}` });
    const tightQuota = { maxOrganizationAttachments: 1 };
    const expired = await createAttachment(
      app.db,
      {
        organizationId: admin.organizationId,
        mimeType: "application/octet-stream",
        filename: "occupant.bin",
        body: Buffer.from("occupant"),
        uploadedBy: admin.humanAgentUuid,
      },
      tightQuota,
    );
    await app.db
      .update(attachments)
      .set({ createdAt: new Date(Date.now() - EXPIRED_AGE_MS) })
      .where(eq(attachments.id, expired.id));
    await expect(
      createAttachment(
        app.db,
        {
          organizationId: admin.organizationId,
          mimeType: "application/octet-stream",
          filename: "blocked.bin",
          body: Buffer.from("blocked"),
          uploadedBy: admin.humanAgentUuid,
        },
        tightQuota,
      ),
    ).rejects.toThrow("Organization attachment quota of 1 objects exceeded");

    const result = await sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, { deleteEnabled: true });
    expect(result.deleted).toBe(1);

    await expect(
      createAttachment(
        app.db,
        {
          organizationId: admin.organizationId,
          mimeType: "application/octet-stream",
          filename: "after-cleanup.bin",
          body: Buffer.from("after"),
          uploadedBy: admin.humanAgentUuid,
        },
        tightQuota,
      ),
    ).resolves.toMatchObject({ lifecycleState: "ready" });
  });

  it("honors the exact 14-day boundary: created at the cutoff survives, 1ms older is deleted", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `ret-edge-${crypto.randomUUID().slice(0, 6)}` });
    const now = new Date("2026-08-13T00:00:00.000Z");
    const cutoff = new Date(now.getTime() - MESSAGE_ATTACHMENT_RETENTION_MS);
    const atCutoff = await createAgedAttachment(app, admin, 0, "at-cutoff.bin");
    const oneMsOlder = await createAgedAttachment(app, admin, 0, "one-ms-older.bin");
    await app.db.update(attachments).set({ createdAt: cutoff }).where(eq(attachments.id, atCutoff.id));
    await app.db
      .update(attachments)
      .set({ createdAt: new Date(cutoff.getTime() - 1) })
      .where(eq(attachments.id, oneMsOlder.id));

    const result = await sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, {
      deleteEnabled: true,
      now,
    });

    expect(result.deleted).toBe(1);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, atCutoff.id))).toHaveLength(1);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, oneMsOlder.id))).toHaveLength(0);
  });

  it("honors a bundle reference that lands between candidate selection and deletion", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `ret-race-${crypto.randomUUID().slice(0, 6)}` });
    const bundle = await createAgedAttachment(app, admin, EXPIRED_AGE_MS, "race-bundle.zip");

    let sweepPromise: Promise<Awaited<ReturnType<typeof sweepExpiredMessageAttachments>>> | undefined;
    await app.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      // The bind path's FOR KEY SHARE reference lock conflicts with the
      // sweep's FOR UPDATE, so the sweep cannot delete until this transaction
      // commits — and by then the Resource reference is visible to its
      // in-transaction re-check.
      await loadAttachmentMetaForReference(tx, bundle.id);
      sweepPromise = sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, { deleteEnabled: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.insert(resources).values({
        id: uuidv7(),
        organizationId: admin.organizationId,
        type: "skill",
        scope: "team",
        name: `race-guard-${crypto.randomUUID().slice(0, 8)}`,
        bundleAttachmentId: bundle.id,
        payload: { name: "race-guard", description: "d", body: "# guard", metadata: {} },
        createdBy: admin.memberId,
        updatedBy: admin.memberId,
      });
    });

    const result = await sweepPromise;
    expect(result?.deleted ?? 0).toBe(0);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, bundle.id))).toHaveLength(1);
  });
});
