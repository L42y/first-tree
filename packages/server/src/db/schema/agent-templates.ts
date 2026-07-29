import type { AgentTemplateStatus } from "@first-tree/shared";
import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Official online Agent Templates.
 *
 * Resource references are logical, not foreign keys. Template mutations lock
 * and validate the referenced rows in the service layer so Resource retirement
 * and Template editing cannot race.
 */
export const agentTemplates = pgTable("agent_templates", {
  /** Immutable public slug. Retired ids are never recycled. */
  id: text("id").primaryKey(),
  /** The configured official publisher organization. Deliberately no FK. */
  organizationId: text("organization_id").notNull(),
  /** Optimistic-lock counter for official-admin edits; not revision history. */
  version: integer("version").notNull().default(1),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  outcomes: text("outcomes").array().notNull().default(sql`'{}'::text[]`),
  customInstructions: text("custom_instructions").notNull(),
  /** Team Skill/MCP Resource ids. Resource.type determines projection. */
  resourceIds: text("resource_ids").array().notNull().default(sql`'{}'::text[]`),
  status: text("status").$type<AgentTemplateStatus>().notNull().default("active"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
