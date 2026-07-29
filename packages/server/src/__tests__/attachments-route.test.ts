import type { Readable } from "node:stream";
import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER, MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { attachments } from "../db/schema/attachments.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import {
  attachmentObjectKey,
  backfillLegacyAttachments,
  createAttachment,
  deleteAttachmentIfUnreferenced,
  MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER,
  ORPHAN_ATTACHMENT_AGE_MS,
  sweepOrphanAttachments,
} from "../services/attachment.js";
import { type AttachmentBlobStore, MemoryAttachmentBlobStore } from "../services/attachment-blob-store.js";
import { validateMessageAttachmentRefs } from "../services/doc-snapshots.js";
import { ensureMembership } from "../services/membership.js";
import { editMessage, lockFileAttachmentRefsIfPresent, sendMessage } from "../services/message.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAdmin, useTestApp } from "./helpers.js";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

function postAttachment(
  app: FastifyInstance,
  caller: Admin,
  payload: Buffer,
  overrides: Partial<{ mime: string; filename: string; contentType: string; orgId: string }> = {},
) {
  const orgId = overrides.orgId ?? caller.organizationId;
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/attachments`,
    headers: {
      authorization: `Bearer ${caller.accessToken}`,
      "content-type": overrides.contentType ?? "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: overrides.mime ?? "image/png",
      [ATTACHMENT_FILENAME_HEADER]: overrides.filename ?? "test.png",
    },
    payload,
  });
}

function getAttachment(app: FastifyInstance, caller: Admin, id: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/attachments/${id}`,
    headers: { authorization: `Bearer ${caller.accessToken}` },
  });
}

describe("attachments route — upload + capability download", () => {
  const getApp = useTestApp();

  it("uploads then downloads via uploader", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `up-self-${crypto.randomUUID().slice(0, 6)}` });

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = await postAttachment(app, admin, bytes, { filename: "kitten.png" });
    expect(upload.statusCode).toBe(201);
    const body = upload.json() as { id: string; sizeBytes: number; uploadedBy: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.sizeBytes).toBe(bytes.byteLength);
    expect(body.uploadedBy).toBe(admin.humanAgentUuid);

    const download = await getAttachment(app, admin, body.id);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.headers["content-length"]).toBe(String(bytes.byteLength));
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(download.headers.etag).toBe(`"${body.id}"`);
    expect(download.headers["content-disposition"]).toBe('inline; filename="kitten.png"');
    expect(download.rawPayload.equals(bytes)).toBe(true);
  });

  it("resumes an interrupted legacy object-store backfill", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `resume-${crypto.randomUUID().slice(0, 6)}` });
    const id = crypto.randomUUID();
    const bytes = Buffer.from("legacy");
    await app.db.insert(attachments).values({
      id,
      organizationId: admin.organizationId,
      objectKey: attachmentObjectKey(admin.organizationId, id),
      lifecycleState: "uploading",
      mimeType: "application/octet-stream",
      filename: "legacy.bin",
      sizeBytes: bytes.byteLength,
      data: bytes,
      uploadedBy: admin.humanAgentUuid,
      updatedAt: new Date(Date.now() - 16 * 60 * 1_000),
    });

    await expect(backfillLegacyAttachments(app.db, app.attachmentBlobStore)).resolves.toMatchObject({ migrated: 1 });
    const [stored] = await app.db.select().from(attachments).where(eq(attachments.id, id));
    expect(stored).toMatchObject({ lifecycleState: "ready", data: null });
    const download = await getAttachment(app, admin, id);
    expect(download.rawPayload.equals(bytes)).toBe(true);
  });

  it("does not let a failed stale backfill claim overwrite a newer successful claim", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `backfill-cas-${crypto.randomUUID().slice(0, 6)}` });
    const id = crypto.randomUUID();
    const bytes = Buffer.from("legacy-race");
    await app.db.insert(attachments).values({
      id,
      organizationId: admin.organizationId,
      objectKey: null,
      lifecycleState: "ready",
      mimeType: "application/octet-stream",
      filename: "legacy-race.bin",
      sizeBytes: bytes.byteLength,
      data: bytes,
      uploadedBy: admin.humanAgentUuid,
    });

    let signalFirstPut!: () => void;
    const firstPutStarted = new Promise<void>((resolve) => {
      signalFirstPut = resolve;
    });
    let releaseFirstPut!: () => void;
    const firstPutReleased = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    const failingStore: AttachmentBlobStore = {
      async put(_key, body) {
        for await (const _chunk of body) {
          // Drain the claimed bytes before exposing the interleaving point.
        }
        signalFirstPut();
        await firstPutReleased;
        throw new Error("simulated stale claimant failure");
      },
      async get() {
        throw new Error("not used");
      },
      async delete() {},
    };

    const staleClaim = backfillLegacyAttachments(app.db, failingStore);
    await firstPutStarted;
    await app.db
      .update(attachments)
      .set({ updatedAt: new Date(Date.now() - 16 * 60 * 1_000) })
      .where(eq(attachments.id, id));

    const successfulStore = new MemoryAttachmentBlobStore();
    await expect(backfillLegacyAttachments(app.db, successfulStore)).resolves.toMatchObject({ migrated: 1 });
    releaseFirstPut();
    await expect(staleClaim).resolves.toMatchObject({ skipped: 1 });

    const [stored] = await app.db.select().from(attachments).where(eq(attachments.id, id));
    expect(stored).toMatchObject({
      objectKey: attachmentObjectKey(admin.organizationId, id),
      lifecycleState: "ready",
      data: null,
    });
    expect(successfulStore.objects.get(attachmentObjectKey(admin.organizationId, id))).toEqual(bytes);
  });

  it("revalidates a preselected sweep candidate after backfill claims it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `sweep-claim-${crypto.randomUUID().slice(0, 6)}` });
    const id = crypto.randomUUID();
    const bytes = Buffer.from("legacy-sweep-race");
    const sweepNow = new Date();
    const sweepCutoff = new Date(sweepNow.getTime() - ORPHAN_ATTACHMENT_AGE_MS);
    await app.db.insert(attachments).values({
      id,
      organizationId: admin.organizationId,
      objectKey: null,
      lifecycleState: "ready",
      mimeType: "application/octet-stream",
      filename: "legacy-sweep-race.bin",
      sizeBytes: bytes.byteLength,
      data: bytes,
      uploadedBy: admin.humanAgentUuid,
      updatedAt: new Date(sweepCutoff.getTime() - 1_000),
    });

    let signalPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      signalPutStarted = resolve;
    });
    let releasePut!: () => void;
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    class BlockingBackfillStore extends MemoryAttachmentBlobStore {
      override async put(key: string, body: Readable): Promise<void> {
        signalPutStarted();
        await putReleased;
        await super.put(key, body);
      }
    }
    const store = new BlockingBackfillStore();

    // The stale id represents the sweeper's candidate read. Backfill claims
    // that row before cleanup takes its row lock and refreshes updatedAt.
    const backfill = backfillLegacyAttachments(app.db, store);
    await putStarted;
    await expect(deleteAttachmentIfUnreferenced(app.db, store, id, { orphanCutoff: sweepCutoff })).resolves.toBe(false);

    const [claimed] = await app.db.select().from(attachments).where(eq(attachments.id, id));
    expect(claimed).toMatchObject({ lifecycleState: "uploading", data: bytes });
    releasePut();
    await expect(backfill).resolves.toMatchObject({ migrated: 1 });

    const [stored] = await app.db.select().from(attachments).where(eq(attachments.id, id));
    expect(stored).toMatchObject({ lifecycleState: "ready", data: null });
    expect(store.objects.get(attachmentObjectKey(admin.organizationId, id))).toEqual(bytes);
  });

  it("bounds simultaneous upload streams for one caller using shared lifecycle rows", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `upload-bound-${crypto.randomUUID().slice(0, 6)}` });
    let startedCount = 0;
    let signalLimitReached!: () => void;
    const limitReached = new Promise<void>((resolve) => {
      signalLimitReached = resolve;
    });
    let releaseUploads!: () => void;
    const uploadsReleased = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    class BlockingBlobStore extends MemoryAttachmentBlobStore {
      override async put(key: string, body: Readable): Promise<void> {
        startedCount += 1;
        if (startedCount === MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER) signalLimitReached();
        if (startedCount > MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER) {
          throw new Error("unexpected upload stream admitted");
        }
        await uploadsReleased;
        await super.put(key, body);
      }
    }
    const store = new BlockingBlobStore();
    const input = (index: number) => ({
      organizationId: admin.organizationId,
      mimeType: "application/octet-stream",
      filename: `parallel-${index}.bin`,
      body: Buffer.from(`parallel-${index}`),
      uploadedBy: admin.humanAgentUuid,
    });
    const active = Array.from({ length: MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER }, (_, index) =>
      createAttachment(app.db, store, input(index)),
    );

    await limitReached;
    await expect(createAttachment(app.db, store, input(MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER))).rejects.toThrow(
      `already has ${MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER}`,
    );
    expect(startedCount).toBe(MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER);

    releaseUploads();
    const completed = await Promise.all(active);
    expect(completed).toHaveLength(MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER);
    expect(completed.every((row) => row.lifecycleState === "ready")).toBe(true);
  });

  it("retains a deleting row when failed-upload object cleanup fails", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `failed-delete-${crypto.randomUUID().slice(0, 6)}` });
    const id = crypto.randomUUID();
    const objectKey = attachmentObjectKey(admin.organizationId, id);
    class RecoveringDeleteStore extends MemoryAttachmentBlobStore {
      failDelete = true;

      override async delete(key: string): Promise<void> {
        if (this.failDelete) throw new Error("simulated object deletion failure");
        await super.delete(key);
      }
    }
    const store = new RecoveringDeleteStore();

    await expect(
      createAttachment(app.db, store, {
        id,
        organizationId: admin.organizationId,
        mimeType: "application/octet-stream",
        filename: "failed-delete.bin",
        body: Buffer.from("three"),
        contentLength: 3,
        uploadedBy: admin.humanAgentUuid,
      }),
    ).rejects.toThrow("Content-Length does not match");

    expect(store.objects.get(objectKey)).toEqual(Buffer.from("three"));
    const [retained] = await app.db.select().from(attachments).where(eq(attachments.id, id));
    expect(retained).toMatchObject({ id, objectKey, lifecycleState: "deleting" });

    store.failDelete = false;
    await expect(sweepOrphanAttachments(app.db, store)).resolves.toMatchObject({ deleted: 1 });
    expect(store.objects.has(objectKey)).toBe(false);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, id))).toHaveLength(0);
  });

  it("holds attachment reference locks until the message transaction commits", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `ref-lock-${crypto.randomUUID().slice(0, 6)}` });
    const stored = await createAttachment(app.db, app.attachmentBlobStore, {
      organizationId: admin.organizationId,
      mimeType: "text/markdown",
      filename: "locked.md",
      body: Buffer.from("locked"),
      uploadedBy: admin.humanAgentUuid,
    });
    const chatId = uuidv7();
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    const metadata = {
      attachments: [
        {
          attachmentId: stored.id,
          kind: "document" as const,
          mimeType: stored.mimeType,
          filename: stored.filename,
          size: stored.sizeBytes,
          sha256: "a".repeat(64),
          source: { path: "locked.md" },
        },
      ],
    };

    await app.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      await validateMessageAttachmentRefs(tx, metadata);
      const lockError = await app.db
        .transaction(async (cleanupTx) => {
          await cleanupTx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          await cleanupTx
            .select({ id: attachments.id })
            .from(attachments)
            .where(eq(attachments.id, stored.id))
            .for("update");
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(lockError).toBeInstanceOf(Error);
      const wrapped = lockError as Error & { cause?: unknown };
      const causeMessage = wrapped.cause instanceof Error ? wrapped.cause.message : String(wrapped.cause ?? "");
      expect(`${wrapped.message} ${causeMessage}`).toMatch(/lock timeout/);
      await tx.insert(messages).values({
        id: uuidv7(),
        chatId,
        senderId: admin.humanAgentUuid,
        format: "markdown",
        content: "message keeps the attachment",
        metadata,
        source: "api",
      });
    });

    await expect(deleteAttachmentIfUnreferenced(app.db, app.attachmentBlobStore, stored.id)).resolves.toBe(false);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, stored.id))).toHaveLength(1);
  });

  it("holds single and batch file-content reference locks until message commit", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `file-ref-lock-${crypto.randomUUID().slice(0, 6)}` });
    const stored = await createAttachment(app.db, app.attachmentBlobStore, {
      organizationId: admin.organizationId,
      mimeType: "image/png",
      filename: "locked.png",
      body: Buffer.from("locked-image"),
      uploadedBy: admin.humanAgentUuid,
    });
    const chatId = uuidv7();
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    const ref = {
      imageId: stored.id,
      mimeType: "image/png" as const,
      filename: stored.filename,
      size: stored.sizeBytes,
    };
    const contents = [ref, { caption: "batch", attachments: [ref] }];

    for (const content of contents) {
      await app.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        await lockFileAttachmentRefsIfPresent(tx, "file", content);
        const lockError = await app.db
          .transaction(async (cleanupTx) => {
            await cleanupTx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
            await cleanupTx
              .select({ id: attachments.id })
              .from(attachments)
              .where(eq(attachments.id, stored.id))
              .for("update");
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(lockError).toBeInstanceOf(Error);
        const wrapped = lockError as Error & { cause?: unknown };
        const causeMessage = wrapped.cause instanceof Error ? wrapped.cause.message : String(wrapped.cause ?? "");
        expect(`${wrapped.message} ${causeMessage}`).toMatch(/lock timeout/);
        await tx.insert(messages).values({
          id: uuidv7(),
          chatId,
          senderId: admin.humanAgentUuid,
          format: "file",
          content,
          source: "web",
        });
      });
    }

    await expect(deleteAttachmentIfUnreferenced(app.db, app.attachmentBlobStore, stored.id)).resolves.toBe(false);
  });

  it("keeps legacy single and batch file references shape-only", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `file-ref-send-${crypto.randomUUID().slice(0, 6)}` });
    const chatId = uuidv7();
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    const missingRef = {
      imageId: crypto.randomUUID(),
      mimeType: "image/png" as const,
      filename: "missing.png",
    };

    await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { format: "file", content: missingRef, source: "web" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { format: "file", content: { attachments: [missingRef] }, source: "web" },
      { allowRecipientlessSend: true },
    );

    const stored = await createAttachment(app.db, app.attachmentBlobStore, {
      organizationId: admin.organizationId,
      mimeType: "image/png",
      filename: "actual.png",
      body: Buffer.from("actual"),
      uploadedBy: admin.humanAgentUuid,
    });
    await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      {
        format: "file",
        content: {
          imageId: stored.id,
          mimeType: "image/jpeg",
          filename: "declared.jpg",
          size: stored.sizeBytes + 1,
        },
        source: "web",
      },
      { allowRecipientlessSend: true },
    );

    const existingId = uuidv7();
    await app.db.insert(messages).values({
      id: existingId,
      chatId,
      senderId: admin.humanAgentUuid,
      format: "text",
      content: "before edit",
      source: "web",
    });
    await editMessage(
      app.db,
      chatId,
      existingId,
      admin.humanAgentUuid,
      {
        format: "file",
        content: missingRef,
      },
      app.attachmentBlobStore,
    );
    const edited = await editMessage(
      app.db,
      chatId,
      existingId,
      admin.humanAgentUuid,
      {
        format: "file",
        content: { attachments: [missingRef] },
      },
      app.attachmentBlobStore,
    );

    expect(edited).toMatchObject({ format: "file", content: { attachments: [missingRef] } });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(4);
  });

  it("immediately cleans legacy file refs released by replacement and file-to-text edits", async () => {
    const app = getApp();
    const store = app.attachmentBlobStore as MemoryAttachmentBlobStore;
    const admin = await createTestAdmin(app, { username: `file-ref-edit-${crypto.randomUUID().slice(0, 6)}` });
    const chatId = uuidv7();
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    const previous = await createAttachment(app.db, app.attachmentBlobStore, {
      organizationId: admin.organizationId,
      mimeType: "image/png",
      filename: "previous.png",
      body: Buffer.from("previous"),
      uploadedBy: admin.humanAgentUuid,
    });
    const replacement = await createAttachment(app.db, app.attachmentBlobStore, {
      organizationId: admin.organizationId,
      mimeType: "image/png",
      filename: "replacement.png",
      body: Buffer.from("replacement"),
      uploadedBy: admin.humanAgentUuid,
    });
    const messageId = uuidv7();
    await app.db.insert(messages).values({
      id: messageId,
      chatId,
      senderId: admin.humanAgentUuid,
      format: "file",
      content: {
        imageId: previous.id,
        mimeType: "image/svg+xml",
        filename: previous.filename,
        size: previous.sizeBytes,
      },
      source: "web",
    });

    await editMessage(
      app.db,
      chatId,
      messageId,
      admin.humanAgentUuid,
      {
        content: {
          caption: "replacement",
          attachments: [
            {
              imageId: replacement.id,
              mimeType: "image/png",
              filename: replacement.filename,
              size: replacement.sizeBytes,
            },
          ],
        },
      },
      store,
    );
    expect(await app.db.select().from(attachments).where(eq(attachments.id, previous.id))).toHaveLength(0);
    expect(store.objects.has(attachmentObjectKey(admin.organizationId, previous.id))).toBe(false);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, replacement.id))).toHaveLength(1);

    await editMessage(
      app.db,
      chatId,
      messageId,
      admin.humanAgentUuid,
      { format: "text", content: "images removed" },
      store,
    );
    expect(await app.db.select().from(attachments).where(eq(attachments.id, replacement.id))).toHaveLength(0);
    expect(store.objects.has(attachmentObjectKey(admin.organizationId, replacement.id))).toBe(false);

    const retry = await createAttachment(app.db, store, {
      organizationId: admin.organizationId,
      mimeType: "image/png",
      filename: "retry.png",
      body: Buffer.from("retry"),
      uploadedBy: admin.humanAgentUuid,
    });
    const retryMessageId = uuidv7();
    await app.db.insert(messages).values({
      id: retryMessageId,
      chatId,
      senderId: admin.humanAgentUuid,
      format: "file",
      content: { imageId: retry.id, mimeType: "image/png", filename: retry.filename },
      source: "web",
    });
    const failingDeleteStore: AttachmentBlobStore = {
      put: store.put.bind(store),
      get: store.get.bind(store),
      async delete() {
        throw new Error("simulated post-edit deletion failure");
      },
    };

    await editMessage(
      app.db,
      chatId,
      retryMessageId,
      admin.humanAgentUuid,
      { format: "text", content: "retry later" },
      failingDeleteStore,
    );
    const [retained] = await app.db.select().from(attachments).where(eq(attachments.id, retry.id));
    expect(retained).toMatchObject({ lifecycleState: "deleting" });
    expect(store.objects.has(attachmentObjectKey(admin.organizationId, retry.id))).toBe(true);

    await sweepOrphanAttachments(app.db, store);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, retry.id))).toHaveLength(0);
    expect(store.objects.has(attachmentObjectKey(admin.organizationId, retry.id))).toBe(false);
  });

  it("capability model: any authenticated user with the id can download", async () => {
    const app = getApp();
    const uploader = await createAdminContext(app, { username: `cap-up-${crypto.randomUUID().slice(0, 6)}` });
    const other = await createAdminContext(app, { username: `cap-ot-${crypto.randomUUID().slice(0, 6)}` });

    const bytes = Buffer.from("shared-by-capability");
    const upload = await postAttachment(app, uploader, bytes);
    const id = (upload.json() as { id: string }).id;

    // A different authenticated user who knows the id downloads it — the
    // unguessable id is the bearer capability; no chat/uploader relation
    // required. Stronger ACL is the consumer's job, not the primitive's.
    const download = await getAttachment(app, other, id);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(bytes)).toBe(true);
  });

  it("rejects download without a JWT (401)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noauth-${crypto.randomUUID().slice(0, 6)}` });
    const upload = await postAttachment(app, admin, Buffer.from("guarded"));
    const id = (upload.json() as { id: string }).id;

    const reply = await app.inject({ method: "GET", url: `/api/v1/attachments/${id}` });
    expect(reply.statusCode).toBe(401);
  });

  it("ETag 304 on If-None-Match hit", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `etag-${crypto.randomUUID().slice(0, 6)}` });
    const upload = await postAttachment(app, admin, Buffer.from("hi"));
    const id = (upload.json() as { id: string }).id;

    const reply = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${id}`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "if-none-match": `"${id}"`,
      },
    });
    expect(reply.statusCode).toBe(304);
  });

  it("rejects upload with wrong Content-Type", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `wct-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await postAttachment(app, admin, Buffer.from("hi"), { contentType: "application/json" });
    expect(reply.statusCode).toBe(400);
  });

  it("rejects upload missing the mime header", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `mh-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/attachments`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "content-type": "application/octet-stream",
        [ATTACHMENT_FILENAME_HEADER]: "x.bin",
      },
      payload: Buffer.from("hi"),
    });
    expect(reply.statusCode).toBe(400);
  });

  it("rejects empty body", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `eb-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await postAttachment(app, admin, Buffer.alloc(0));
    expect(reply.statusCode).toBe(400);
  });

  it("rejects blank attachment mime type and filename", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `blank-attachment-${crypto.randomUUID().slice(0, 6)}` });

    const blankMime = await postAttachment(app, admin, Buffer.from("mime"), { mime: " " });
    expect(blankMime.statusCode).toBe(400);

    await expect(
      createAttachment(app.db, app.attachmentBlobStore, {
        organizationId: admin.organizationId,
        mimeType: "image/png",
        filename: " ",
        body: Buffer.from("filename"),
        uploadedBy: admin.humanAgentUuid,
      }),
    ).rejects.toThrow("Attachment filename is required");
  });

  it("rejects a mismatched declared byte length", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `length-${crypto.randomUUID().slice(0, 6)}` });
    await expect(
      createAttachment(app.db, app.attachmentBlobStore, {
        organizationId: admin.organizationId,
        mimeType: "application/octet-stream",
        filename: "length.bin",
        body: Buffer.from("three"),
        contentLength: 3,
        uploadedBy: admin.humanAgentUuid,
      }),
    ).rejects.toThrow("Content-Length does not match");
  });

  it("rejects oversize at bodyLimit (413) or service cap (400)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `os-${crypto.randomUUID().slice(0, 6)}` });
    // 1 KB over the cap — well under the route bodyLimit, so the service-
    // layer cap is what fires.
    const oversize = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024);
    const reply = await postAttachment(app, admin, oversize);
    expect([400, 413]).toContain(reply.statusCode);
  });

  it("returns 404 for unknown attachment id", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `nf-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await getAttachment(app, admin, "00000000-0000-4000-8000-000000000000");
    expect(reply.statusCode).toBe(404);
  });

  it("rejects upload to an org the caller is not a member of (403)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noorg-${crypto.randomUUID().slice(0, 6)}` });

    const foreignOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: foreignOrgId, name: foreignOrgId.slice(0, 30), displayName: "Foreign Org" });

    const reply = await postAttachment(app, admin, Buffer.from("nope"), { orgId: foreignOrgId });
    expect(reply.statusCode).toBe(403);
  });

  it("uploaded_by is determined by the org in the path (multi-org caller)", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `mo-${crypto.randomUUID().slice(0, 6)}` });

    // Seed a second org with a brand-new humanAgent for the same user.
    const otherOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: otherOrgId, name: otherOrgId.slice(0, 30), displayName: "Other Org" });
    const otherMember = await ensureMembership(app.db, {
      userId: admin.userId,
      organizationId: otherOrgId,
      role: "member",
      displayName: "Other Org Agent",
      username: admin.username,
    });

    // Upload via the first org → uploaded_by = first org's humanAgent.
    const first = await postAttachment(app, admin, Buffer.from("first"));
    expect(first.statusCode).toBe(201);
    expect((first.json() as { uploadedBy: string }).uploadedBy).toBe(admin.humanAgentUuid);

    // Upload via the second org → uploaded_by = second org's humanAgent.
    const second = await postAttachment(app, admin, Buffer.from("second"), { orgId: otherOrgId });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { uploadedBy: string }).uploadedBy).toBe(otherMember.agentId);
  });
});
