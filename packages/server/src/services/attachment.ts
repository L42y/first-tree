import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { attachments } from "../db/schema/attachments.js";
import { messages } from "../db/schema/messages.js";
import { resources } from "../db/schema/resources.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type { AttachmentBlobStore } from "./attachment-blob-store.js";

export const MAX_ORGANIZATION_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ORGANIZATION_ATTACHMENTS = 1_000;
export const MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER = 3;
export const ORPHAN_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1_000;
const LEGACY_BACKFILL_CLAIM_STALE_MS = 15 * 60 * 1_000;

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
 * Reserve team quota, stream an immutable object into the blob store, then
 * publish its metadata as ready. A failed upload never leaves a readable row.
 */
export async function createAttachment(
  db: Database,
  blobStore: AttachmentBlobStore,
  input: CreateAttachmentInput,
): Promise<AttachmentRow> {
  validateCreateInput(input);
  const id = input.id ?? randomUUID();
  const objectKey = attachmentObjectKey(input.organizationId, id);
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
      objectKey,
      lifecycleState: "uploading",
      mimeType: input.mimeType.trim(),
      filename: input.filename.trim(),
      sizeBytes: reservedBytes,
      data: null,
      uploadedBy: input.uploadedBy,
    });
  });

  let measuredBytes = 0;
  try {
    const source = Buffer.isBuffer(input.body) ? Readable.from([input.body]) : input.body;
    const limited = Readable.from(
      (async function* () {
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          measuredBytes += bytes.byteLength;
          if (measuredBytes > MAX_ATTACHMENT_BYTES) {
            throw new BadRequestError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
          }
          yield bytes;
        }
      })(),
    );
    await blobStore.put(objectKey, limited, input.contentLength);
    if (measuredBytes === 0) throw new BadRequestError("Attachment is empty");
    if (input.contentLength !== undefined && measuredBytes !== input.contentLength) {
      throw new BadRequestError("Attachment Content-Length does not match the uploaded bytes");
    }

    await db.transaction(async (tx) => {
      const targetDb = tx as unknown as Database;
      await lockOrganizationAttachmentQuota(targetDb, input.organizationId);
      await assertOrganizationQuota(targetDb, input.organizationId, {
        excludeId: id,
        additionalObjects: 1,
        additionalBytes: measuredBytes,
      });
      await targetDb
        .update(attachments)
        .set({
          lifecycleState: "ready",
          sizeBytes: measuredBytes,
          updatedAt: new Date(),
        })
        .where(eq(attachments.id, id));
    });
  } catch (error) {
    await blobStore.delete(objectKey).catch(() => undefined);
    await db.delete(attachments).where(eq(attachments.id, id));
    throw error;
  }

  const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!row) throw new Error("Attachment insert returned no row");
  return row;
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

export function attachmentObjectKey(organizationId: string, id: string): string {
  return `attachments/${organizationId}/${id}`;
}

/** Everything in `AttachmentRow` except the legacy PostgreSQL payload. */
export type AttachmentMeta = Omit<AttachmentRow, "data">;

export type AttachmentReader = Pick<Database, "select">;

export async function loadAttachmentMeta(db: AttachmentReader, id: string): Promise<AttachmentMeta | null> {
  const [row] = await db
    .select({
      id: attachments.id,
      organizationId: attachments.organizationId,
      objectKey: attachments.objectKey,
      lifecycleState: attachments.lifecycleState,
      mimeType: attachments.mimeType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      uploadedBy: attachments.uploadedBy,
      createdAt: attachments.createdAt,
      updatedAt: attachments.updatedAt,
    })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "ready")))
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
      objectKey: attachments.objectKey,
      lifecycleState: attachments.lifecycleState,
      mimeType: attachments.mimeType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      uploadedBy: attachments.uploadedBy,
      createdAt: attachments.createdAt,
      updatedAt: attachments.updatedAt,
    })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "ready")))
    .for("key share")
    .limit(1);
  return row ?? null;
}

/**
 * Open an attachment without buffering it in the server. Legacy BYTEA rows
 * remain readable while the object-store backfill is in progress.
 */
export async function openAttachmentStream(
  db: Database,
  blobStore: AttachmentBlobStore,
  id: string,
): Promise<Readable | null> {
  const [row] = await db
    .select({
      objectKey: attachments.objectKey,
      lifecycleState: attachments.lifecycleState,
      data: attachments.data,
    })
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  if (!row || row.lifecycleState !== "ready") return null;
  if (row.objectKey) {
    try {
      return await blobStore.get(row.objectKey);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }
  return row.data ? Readable.from([row.data]) : null;
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

/**
 * Delete an immutable object only after every known consumer has released it.
 * Failed object-store deletion leaves a `deleting` row for the sweeper.
 */
export async function deleteAttachmentIfUnreferenced(
  db: Database,
  blobStore: AttachmentBlobStore,
  id: string,
): Promise<boolean> {
  let objectKey: string | null = null;
  let shouldDelete = false;
  await db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    const [row] = await targetDb
      .select({
        id: attachments.id,
        objectKey: attachments.objectKey,
        lifecycleState: attachments.lifecycleState,
      })
      .from(attachments)
      .where(eq(attachments.id, id))
      .for("update")
      .limit(1);
    if (!row) return;
    if (await isAttachmentReferenced(targetDb, id)) {
      // Move live rows out of the bounded orphan scan window. Without this
      // touch, the same oldest referenced rows could permanently starve later
      // orphan candidates from the batch.
      if (row.lifecycleState !== "deleting") {
        await targetDb.update(attachments).set({ updatedAt: new Date() }).where(eq(attachments.id, id));
      }
      return;
    }
    objectKey = row.objectKey;
    shouldDelete = true;
    await targetDb
      .update(attachments)
      .set({ lifecycleState: "deleting", updatedAt: new Date() })
      .where(eq(attachments.id, id));
  });
  if (!shouldDelete) return false;
  if (objectKey) await blobStore.delete(objectKey);
  await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "deleting")));
  return true;
}

/**
 * Retry interrupted deletes and remove uploads that stayed unreferenced for
 * the 24-hour grace period. Bounded batches keep the maintenance tick cheap.
 */
export async function sweepOrphanAttachments(
  db: Database,
  blobStore: AttachmentBlobStore,
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
        and(inArray(attachments.lifecycleState, ["uploading", "ready"]), lt(attachments.updatedAt, cutoff)),
      ),
    )
    .limit(batchSize);
  let deleted = 0;
  for (const candidate of candidates) {
    try {
      if (await deleteAttachmentIfUnreferenced(db, blobStore, candidate.id)) deleted++;
    } catch {
      // Keep the lifecycle row for the next retry.
    }
  }
  return { examined: candidates.length, deleted };
}

/**
 * Expand/contract compatibility backfill. It performs network I/O outside the
 * SQL migration, one bounded row at a time, and keeps BYTEA as the fallback
 * until an object write is confirmed.
 */
export async function backfillLegacyAttachments(
  db: Database,
  blobStore: AttachmentBlobStore,
  batchSize = 25,
): Promise<{ migrated: number; skipped: number }> {
  const staleCutoff = new Date(Date.now() - LEGACY_BACKFILL_CLAIM_STALE_MS);
  const rows = await db
    .select({
      id: attachments.id,
      organizationId: attachments.organizationId,
      uploadedBy: attachments.uploadedBy,
    })
    .from(attachments)
    .where(
      and(
        isNotNull(attachments.data),
        or(
          isNull(attachments.objectKey),
          and(eq(attachments.lifecycleState, "uploading"), lt(attachments.updatedAt, staleCutoff)),
        ),
      ),
    )
    .limit(batchSize);
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    let organizationId = row.organizationId;
    if (!organizationId) {
      const [uploader] = await db
        .select({ organizationId: agents.organizationId })
        .from(agents)
        .where(eq(agents.uuid, row.uploadedBy))
        .limit(1);
      organizationId = uploader?.organizationId ?? null;
    }
    if (!organizationId) {
      skipped++;
      continue;
    }
    const objectKey = attachmentObjectKey(organizationId, row.id);
    const claimStartedAt = new Date();
    const [claimed] = await db
      .update(attachments)
      .set({ organizationId, objectKey, lifecycleState: "uploading", updatedAt: claimStartedAt })
      .where(
        and(
          eq(attachments.id, row.id),
          isNotNull(attachments.data),
          or(
            isNull(attachments.objectKey),
            and(eq(attachments.lifecycleState, "uploading"), lt(attachments.updatedAt, staleCutoff)),
          ),
        ),
      )
      .returning({ data: attachments.data, sizeBytes: attachments.sizeBytes });
    if (!claimed?.data) {
      skipped++;
      continue;
    }
    try {
      await blobStore.put(objectKey, Readable.from([claimed.data]), claimed.sizeBytes);
      const [completed] = await db
        .update(attachments)
        .set({ data: null, lifecycleState: "ready", updatedAt: new Date() })
        .where(
          and(
            eq(attachments.id, row.id),
            eq(attachments.objectKey, objectKey),
            eq(attachments.lifecycleState, "uploading"),
            eq(attachments.updatedAt, claimStartedAt),
            isNotNull(attachments.data),
          ),
        )
        .returning({ id: attachments.id });
      if (completed) migrated++;
      else skipped++;
    } catch {
      await db
        .update(attachments)
        .set({ objectKey: null, lifecycleState: "ready", updatedAt: new Date() })
        .where(
          and(
            eq(attachments.id, row.id),
            eq(attachments.objectKey, objectKey),
            eq(attachments.lifecycleState, "uploading"),
            eq(attachments.updatedAt, claimStartedAt),
            isNotNull(attachments.data),
          ),
        );
      skipped++;
    }
  }
  return { migrated, skipped };
}
