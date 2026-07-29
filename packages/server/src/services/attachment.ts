import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
import { and, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { attachments } from "../db/schema/attachments.js";
import { messages } from "../db/schema/messages.js";
import { resources } from "../db/schema/resources.js";
import { BadRequestError, ConflictError } from "../errors.js";
import { createLogger } from "../observability/index.js";

const log = createLogger("attachment");

export const MAX_ORGANIZATION_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ORGANIZATION_ATTACHMENTS = 1_000;
export const MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER = 3;
export const ORPHAN_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1_000;

export type AttachmentRow = typeof attachments.$inferSelect;

export type CreateAttachmentInput = {
  /** Optional caller-supplied id (UUIDv4). Generated when absent. */
  id?: string;
  organizationId: string;
  mimeType: string;
  filename: string;
  body: Buffer | Readable;
  /** Parsed Content-Length, when the transport supplied one. */
  contentLength?: number;
  /** `agents.uuid` of the uploader; humans pass their humanAgentId. */
  uploadedBy: string;
};

/**
 * Reserve team quota, read one bounded upload, and publish the immutable
 * bytes together with their metadata in PostgreSQL.
 */
export async function createAttachment(db: Database, input: CreateAttachmentInput): Promise<AttachmentRow> {
  validateCreateInput(input);
  const id = input.id ?? randomUUID();
  const reservedBytes = input.contentLength ?? MAX_ATTACHMENT_BYTES;

  await db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    await lockOrganizationAttachmentQuota(targetDb, input.organizationId);
    await assertCallerUploadConcurrency(targetDb, input.organizationId, input.uploadedBy);
    await assertOrganizationQuota(targetDb, input.organizationId, {
      additionalObjects: 1,
      additionalBytes: reservedBytes,
    });
    await targetDb.insert(attachments).values({
      id,
      organizationId: input.organizationId,
      objectKey: null,
      lifecycleState: "uploading",
      mimeType: input.mimeType.trim(),
      filename: input.filename.trim(),
      sizeBytes: reservedBytes,
      data: null,
      uploadedBy: input.uploadedBy,
    });
  });

  let bytes: Buffer;
  try {
    bytes = await readAttachmentBody(input.body, input.contentLength);
  } catch (error) {
    try {
      await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "uploading")));
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Attachment upload and reservation cleanup both failed");
    }
    throw error;
  }

  try {
    return await db.transaction(async (tx) => {
      const targetDb = tx as unknown as Database;
      await lockOrganizationAttachmentQuota(targetDb, input.organizationId);
      await assertOrganizationQuota(targetDb, input.organizationId, {
        excludeId: id,
        additionalObjects: 1,
        additionalBytes: bytes.byteLength,
      });
      const [row] = await targetDb
        .update(attachments)
        .set({
          data: bytes,
          lifecycleState: "ready",
          sizeBytes: bytes.byteLength,
          updatedAt: new Date(),
        })
        .where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "uploading")))
        .returning();
      if (!row) throw new Error("Attachment reservation disappeared before PostgreSQL publish");
      return row;
    });
  } catch (error) {
    try {
      await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "uploading")));
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Attachment publish and reservation cleanup both failed");
    }
    throw error;
  }
}

async function readAttachmentBody(body: Buffer | Readable, contentLength?: number): Promise<Buffer> {
  const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
  const chunks: Buffer[] = [];
  let measuredBytes = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    measuredBytes += bytes.byteLength;
    if (measuredBytes > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  if (measuredBytes === 0) throw new BadRequestError("Attachment is empty");
  if (contentLength !== undefined && measuredBytes !== contentLength) {
    throw new BadRequestError("Attachment Content-Length does not match the uploaded bytes");
  }
  return Buffer.concat(chunks, measuredBytes);
}

function validateCreateInput(input: CreateAttachmentInput): void {
  if (input.organizationId.trim().length === 0) {
    throw new BadRequestError("Attachment organization is required");
  }
  if (input.mimeType.trim().length === 0) {
    throw new BadRequestError("Attachment mime type is required");
  }
  if (input.filename.trim().length === 0) {
    throw new BadRequestError("Attachment filename is required");
  }
  if (input.contentLength !== undefined) {
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
      throw new BadRequestError("Attachment Content-Length must be a positive integer");
    }
    if (input.contentLength > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
    }
  }
}

async function assertCallerUploadConcurrency(db: Database, organizationId: string, uploadedBy: string): Promise<void> {
  const [usage] = await db
    .select({ activeCount: sql<number>`count(*)` })
    .from(attachments)
    .where(
      and(
        eq(attachments.organizationId, organizationId),
        eq(attachments.uploadedBy, uploadedBy),
        eq(attachments.lifecycleState, "uploading"),
      ),
    );
  const activeCount = Number(usage?.activeCount ?? 0);
  if (activeCount >= MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER) {
    throw new ConflictError(
      `Caller already has ${MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER} attachment uploads in progress`,
    );
  }
}

async function lockOrganizationAttachmentQuota(db: Database, organizationId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('organization_attachment_quota'), hashtext(${organizationId}))`,
  );
}

async function assertOrganizationQuota(
  db: Database,
  organizationId: string,
  input: {
    excludeId?: string;
    additionalObjects: number;
    additionalBytes: number;
  },
): Promise<void> {
  const conditions = [
    eq(attachments.organizationId, organizationId),
    inArray(attachments.lifecycleState, ["uploading", "ready", "deleting"]),
  ];
  if (input.excludeId) conditions.push(ne(attachments.id, input.excludeId));
  const [usage] = await db
    .select({
      objectCount: sql<number>`count(*)`,
      sizeBytes: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)`,
    })
    .from(attachments)
    .where(and(...conditions));
  const objectCount = Number(usage?.objectCount ?? 0);
  const sizeBytes = Number(usage?.sizeBytes ?? 0);
  if (objectCount + input.additionalObjects > MAX_ORGANIZATION_ATTACHMENTS) {
    throw new BadRequestError(`Organization attachment quota of ${MAX_ORGANIZATION_ATTACHMENTS} objects exceeded`);
  }
  if (sizeBytes + input.additionalBytes > MAX_ORGANIZATION_ATTACHMENT_BYTES) {
    throw new BadRequestError(`Organization attachment quota of ${MAX_ORGANIZATION_ATTACHMENT_BYTES} bytes exceeded`);
  }
}

/** Everything in `AttachmentRow` except the PostgreSQL payload and legacy pointer. */
export type AttachmentMeta = Omit<AttachmentRow, "data" | "objectKey">;

export type AttachmentReader = Pick<Database, "select">;

export async function loadAttachmentMeta(db: AttachmentReader, id: string): Promise<AttachmentMeta | null> {
  const [row] = await db
    .select({
      id: attachments.id,
      organizationId: attachments.organizationId,
      lifecycleState: attachments.lifecycleState,
      mimeType: attachments.mimeType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      uploadedBy: attachments.uploadedBy,
      createdAt: attachments.createdAt,
      updatedAt: attachments.updatedAt,
    })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "ready"), isNotNull(attachments.data)))
    .limit(1);
  return row ?? null;
}

/**
 * Validate a reference while holding a lock that conflicts with orphan
 * cleanup. When called inside the message write transaction, the lock remains
 * held until the message row is committed.
 */
export async function loadAttachmentMetaForReference(db: AttachmentReader, id: string): Promise<AttachmentMeta | null> {
  const [row] = await db
    .select({
      id: attachments.id,
      organizationId: attachments.organizationId,
      lifecycleState: attachments.lifecycleState,
      mimeType: attachments.mimeType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      uploadedBy: attachments.uploadedBy,
      createdAt: attachments.createdAt,
      updatedAt: attachments.updatedAt,
    })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "ready"), isNotNull(attachments.data)))
    .for("key share")
    .limit(1);
  return row ?? null;
}

/** Open the immutable PostgreSQL `bytea` payload as a readable stream. */
export async function openAttachmentStream(db: Database, id: string): Promise<Readable | null> {
  const [row] = await db
    .select({
      lifecycleState: attachments.lifecycleState,
      data: attachments.data,
    })
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  if (!row?.data || row.lifecycleState !== "ready") return null;
  return Readable.from([row.data]);
}

export async function isAttachmentReferenced(db: Database, id: string): Promise<boolean> {
  const [resourceRef] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(eq(resources.bundleAttachmentId, id))
    .limit(1);
  if (resourceRef) return true;

  const imageArray = JSON.stringify([{ imageId: id }]);
  const attachmentArray = JSON.stringify([{ attachmentId: id }]);
  const [messageRef] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      or(
        sql`${messages.content} ->> 'imageId' = ${id}`,
        sql`${messages.content} -> 'attachments' @> ${imageArray}::jsonb`,
        sql`${messages.content} -> 'attachments' @> ${attachmentArray}::jsonb`,
        sql`${messages.metadata} -> 'attachments' @> ${attachmentArray}::jsonb`,
      ),
    )
    .limit(1);
  return !!messageRef;
}

/** Delete an immutable PostgreSQL row only after every known consumer releases it. */
export async function deleteAttachmentIfUnreferenced(
  db: Database,
  id: string,
  options: { orphanCutoff?: Date } = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    const [row] = await targetDb
      .select({
        id: attachments.id,
        objectKey: attachments.objectKey,
        lifecycleState: attachments.lifecycleState,
        data: attachments.data,
        updatedAt: attachments.updatedAt,
      })
      .from(attachments)
      .where(eq(attachments.id, id))
      .for("update")
      .limit(1);
    if (!row) return false;
    if (
      options.orphanCutoff &&
      row.lifecycleState !== "deleting" &&
      !((row.lifecycleState === "uploading" || row.lifecycleState === "ready") && row.updatedAt < options.orphanCutoff)
    ) {
      return false;
    }
    if (await isAttachmentReferenced(targetDb, id)) {
      if (row.lifecycleState !== "deleting") {
        await targetDb.update(attachments).set({ updatedAt: new Date() }).where(eq(attachments.id, id));
      }
      return false;
    }
    // Preserve the recovery pointer for any object-store row produced during
    // the short-lived #2062 deployment window. New PostgreSQL-backed writes
    // always have `data` and never set `objectKey`.
    if (!row.data && row.objectKey) return false;
    const [deleted] = await targetDb
      .delete(attachments)
      .where(eq(attachments.id, id))
      .returning({ id: attachments.id });
    return !!deleted;
  });
}

/**
 * Remove PostgreSQL uploads that stayed unreferenced for the 24-hour grace
 * period. Bounded batches keep the maintenance tick cheap.
 */
export async function sweepOrphanAttachments(
  db: Database,
  now = new Date(),
  batchSize = 100,
): Promise<{ examined: number; deleted: number }> {
  const cutoff = new Date(now.getTime() - ORPHAN_ATTACHMENT_AGE_MS);
  const candidates = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      or(
        eq(attachments.lifecycleState, "deleting"),
        and(eq(attachments.lifecycleState, "uploading"), lt(attachments.updatedAt, cutoff)),
        and(eq(attachments.lifecycleState, "ready"), isNotNull(attachments.data), lt(attachments.updatedAt, cutoff)),
      ),
    )
    .limit(batchSize);
  let deleted = 0;
  for (const candidate of candidates) {
    try {
      if (await deleteAttachmentIfUnreferenced(db, candidate.id, { orphanCutoff: cutoff })) deleted++;
    } catch (error) {
      // Keep the row for the next retry.
      log.warn({ err: error, attachmentId: candidate.id }, "orphan attachment cleanup will retry");
    }
  }
  return { examined: candidates.length, deleted };
}
