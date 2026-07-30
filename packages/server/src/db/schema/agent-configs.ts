import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-agent runtime configuration (server-managed; not the local YAML config).
 *
 * One row per agent. `version` increments on every successful UPDATE
 * (optimistic locking via WHERE version = :expected). Sensitive env values
 * inside `payload.env[*]` are AES-256-GCM encrypted at write time and
 * masked when echoed via the Admin API (see Step 2).
 *
 * Integrity is enforced by the service layer per project convention:
 * no FK / triggers on this table. The single exception is the
 * `template_ids` cardinality CHECK below: the 0..3 Agent Template bound is a
 * per-row cardinality invariant the database can guarantee directly, so it
 * gets a DB-level fence (see the agent-template schema task).
 */
export const agentConfigs = pgTable(
  "agent_configs",
  {
    /** PK + logical FK to agents.uuid; the service layer keeps these in sync. */
    agentId: text("agent_id").primaryKey(),
    /** Optimistic-lock version. Starts at 1; never null. */
    version: integer("version").notNull().default(1),
    /** Full encrypted-at-rest payload; resource-owned runtime fields are resolved at read time. */
    payload: jsonb("payload").$type<AgentRuntimeConfigPayload>().notNull(),
    /**
     * Adopted official Agent Templates (0-3 distinct ids, canonical sort
     * order; position carries no priority). Records which Templates the
     * Agent adopted — the executable configuration itself lives in Team
     * Resources + bindings, and V1 never syncs later Template updates.
     */
    templateIds: text("template_ids").array().notNull().default(sql`'{}'::text[]`),
    /** Member id (or "system" for migration backfill / agent-create insert). */
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Keep this literal in sync with MAX_AGENT_TEMPLATE_IDS in
    // @first-tree/shared (a runtime import would break drizzle-kit generate).
    check("ck_agent_configs_template_ids_cardinality", sql`cardinality(${table.templateIds}) <= 3`),
    index("idx_agent_configs_template_ids").using("gin", table.templateIds),
  ],
);
