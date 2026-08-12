import { customType, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `bytea` column type. Drizzle ships pg primitives but not bytea out of the
 * box. Reads come back as Node `Buffer` (postgres-js); writes accept any
 * `Uint8Array`. Mirrors the helper in `agents.ts` — kept local to this file
 * so the two columns can diverge independently if one ever needs a different
 * marshalling story.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Server-side object storage. Immutable binary bytes and metadata live
 * together in PostgreSQL.
 *
 * Independent blob — intentionally NO `chat_id` / `message_id` columns.
 * Upstream consumers (the `imageId` field inside `messages.content` jsonb,
 * future bookmark metadata, agent avatar references) hold the
 * `attachments.id` reference. One byte sequence, many consumers.
 *
 * Auth happens at the route layer as a capability model: download requires
 * a valid user JWT plus knowledge of the unguessable UUIDv4 id; there is no
 * per-attachment ACL. Stronger, attachment-scoped authorization is the
 * consumer's responsibility. Upload is org-scoped
 * (`POST /api/v1/orgs/:orgId/attachments`) so `uploaded_by` resolves to a
 * stable actor identity. Trusted ingress may use a namespaced integration id.
 *
 * Lifecycle: write-once. Uploads reserve quota as `uploading` and become
 * `ready` only after their `bytea` payload is published. `deleting` remains a
 * compatibility state for rows created by the short-lived external-store
 * implementation.
 */
export type AttachmentLifecycleState = "uploading" | "ready" | "deleting";

export const attachments = pgTable(
  "attachments",
  {
    /** UUIDv4. Same value upstream references store. */
    id: text("id").primaryKey(),
    /** Owning team. No FK so attachment cleanup is application-controlled. */
    organizationId: text("organization_id"),
    /**
     * Transitional pointer for payloads written by #2062. New writes leave it
     * null; reverse-backfilled rows retain it until pre-transition replicas
     * have drained.
     */
    objectKey: text("object_key"),
    lifecycleState: text("lifecycle_state").$type<AttachmentLifecycleState>().notNull().default("ready"),
    /** MIME as declared by the uploader. v1 does not restrict. */
    mimeType: text("mime_type").notNull(),
    filename: text("filename").notNull(),
    /** Server-measured byte length; clients do not get to lie about this. */
    sizeBytes: integer("size_bytes").notNull(),
    /** Immutable PostgreSQL payload; null only while uploading or before the reverse backfill. */
    data: bytea("data"),
    /**
     * Stable actor id for the uploader. Humans store their `humanAgentId`, AI
     * agents store their uuid, and trusted ingress stores a namespaced
     * integration id. No FK —
     * mirrors `messages.sender_id`, which dropped its FK so soft-deleting
     * an agent does not cascade or orphan existing rows.
     */
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attachments_org_state_idx").on(table.organizationId, table.lifecycleState),
    index("attachments_state_updated_idx").on(table.lifecycleState, table.updatedAt),
    index("attachments_uploaded_by_idx").on(table.uploadedBy),
    index("attachments_created_at_idx").on(table.createdAt),
  ],
);
