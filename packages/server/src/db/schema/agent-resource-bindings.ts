import type { AgentResourceBindingMode, ResourceType } from "@first-tree/shared";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";
import { resources } from "./resources.js";

export const agentResourceBindings = pgTable(
  "agent_resource_bindings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "cascade" }),
    type: text("type").$type<ResourceType>().notNull(),
    mode: text("mode").$type<AgentResourceBindingMode>().notNull(),
    resourceId: text("resource_id").references(() => resources.id, { onDelete: "cascade" }),
    replacesResourceId: text("replaces_resource_id").references(() => resources.id, { onDelete: "cascade" }),
    inlinePromptBody: text("inline_prompt_body"),
    repoRef: text("repo_ref"),
    repoLocalPath: text("repo_local_path"),
    order: integer("order").notNull().default(0),
    /**
     * Provenance for bindings auto-created when an Agent adopts an official
     * Agent Template: which Template component created this binding. Both
     * NULL for ordinary bindings, both non-NULL together for Template-created
     * ones (enforced by CHECK). Deliberately no FK to agent_templates. Used
     * to remove exactly the Template-created bindings when a Template is
     * removed from an Agent, without touching manual bindings.
     */
    originTemplateId: text("origin_template_id"),
    originComponentKey: text("origin_component_key"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_agent_resource_bindings_agent").on(table.agentId, table.type),
    index("idx_agent_resource_bindings_resource").on(table.resourceId),
    index("idx_agent_resource_bindings_replaces").on(table.replacesResourceId),
    check(
      "ck_agent_resource_bindings_template_origin_consistency",
      sql`(${table.originTemplateId} IS NULL AND ${table.originComponentKey} IS NULL) OR (${table.originTemplateId} IS NOT NULL AND ${table.originComponentKey} IS NOT NULL)`,
    ),
    // Serves only Template auto-binding lookups; ordinary bindings have NULL
    // provenance and stay out of this partial index.
    index("idx_agent_resource_bindings_template_origin")
      .on(table.agentId, table.originTemplateId)
      .where(sql`${table.originTemplateId} IS NOT NULL`),
  ],
);
