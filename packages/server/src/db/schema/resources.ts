import type {
  ResourceDefaultEnabled,
  ResourcePayload,
  ResourceScope,
  ResourceStatus,
  ResourceType,
} from "@first-tree/shared";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

export const resources = pgTable(
  "resources",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").$type<ResourceType>().notNull(),
    scope: text("scope").$type<ResourceScope>().notNull(),
    ownerAgentId: text("owner_agent_id").references(() => agents.uuid, { onDelete: "cascade" }),
    name: text("name").notNull(),
    repoCanonicalKey: text("repo_canonical_key"),
    /**
     * Immutable ZIP attachment containing the complete Skill directory.
     * Meaningful only when `type = 'skill'`. Deliberately no FK: attachment
     * lifecycle and cross-consumer references are application-managed.
     */
    bundleAttachmentId: text("bundle_attachment_id"),
    defaultEnabled: text("default_enabled").$type<ResourceDefaultEnabled>(),
    status: text("status").$type<ResourceStatus>().notNull().default("active"),
    payload: jsonb("payload").$type<ResourcePayload>().notNull(),
    /**
     * Provenance for Resources imported from an official Agent Template:
     * which Template component this Team Resource was imported from, plus the
     * content digest captured at import time. All three are NULL for ordinary
     * Team Resources and all non-NULL together for Template-imported ones
     * (enforced by CHECK). Deliberately no FK to agent_templates: Template
     * lifecycle must never affect Team-owned Resources, and V1 uses these
     * fields only for import dedup and source display — never for sync.
     */
    originTemplateId: text("origin_template_id"),
    originComponentKey: text("origin_component_key"),
    originContentDigest: text("origin_content_digest"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_resources_org_type_scope").on(table.organizationId, table.type, table.scope),
    index("idx_resources_owner_agent").on(table.ownerAgentId),
    index("idx_resources_repo_key").on(table.organizationId, table.repoCanonicalKey),
    index("idx_resources_bundle_attachment").on(table.bundleAttachmentId),
    uniqueIndex("uq_resources_team_repo_canonical_active")
      .on(table.organizationId, table.repoCanonicalKey)
      .where(
        sql`${table.type} = 'repo' AND ${table.scope} = 'team' AND ${table.status} IN ('active', 'stale') AND ${table.repoCanonicalKey} IS NOT NULL`,
      ),
    uniqueIndex("uq_resources_agent_repo_canonical_active")
      .on(table.organizationId, table.ownerAgentId, table.repoCanonicalKey)
      .where(
        sql`${table.type} = 'repo' AND ${table.scope} = 'agent' AND ${table.status} IN ('active', 'stale') AND ${table.repoCanonicalKey} IS NOT NULL`,
      ),
    check(
      "ck_resources_template_origin_consistency",
      sql`(${table.originTemplateId} IS NULL AND ${table.originComponentKey} IS NULL AND ${table.originContentDigest} IS NULL) OR (${table.originTemplateId} IS NOT NULL AND ${table.originComponentKey} IS NOT NULL AND ${table.originContentDigest} IS NOT NULL)`,
    ),
    // One active/stale Team Resource per imported Template component:
    // re-importing the same Template reuses the Team's (possibly customized)
    // Resource instead of duplicating it. Retired history does not block a
    // future re-import. `type` is deliberately not part of the dedup
    // identity: component keys are unique within a Template across types,
    // and a later type change must not silently create a second Resource.
    uniqueIndex("uq_resources_template_origin_active")
      .on(table.organizationId, table.originTemplateId, table.originComponentKey)
      .where(sql`${table.status} IN ('active', 'stale') AND ${table.originTemplateId} IS NOT NULL`),
  ],
);
