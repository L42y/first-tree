import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

/** One current Feishu Bot identity bound to one First Tree Agent. */
export const imBotBindings = pgTable(
  "im_bot_bindings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "restrict" }),
    appId: text("app_id"),
    botOpenId: text("bot_open_id"),
    botName: text("bot_name"),
    botAvatarUrl: text("bot_avatar_url"),
    tenantKey: text("tenant_key"),
    appSecretCipher: text("app_secret_cipher"),
    registrationStateCipher: text("registration_state_cipher"),
    registrationExpiresAt: timestamp("registration_expires_at", { withTimezone: true }),
    grantedScopes: text("granted_scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    status: text("status").notNull().default("provisioning"),
    connectionStatus: text("connection_status").notNull().default("disconnected"),
    // Expiring ownership snapshot. Lease expiry and epoch fencing, rather than
    // a server_instances FK, decouple ephemeral server cleanup from Bot state.
    connectionOwnerInstanceId: text("connection_owner_instance_id"),
    connectionLeaseExpiresAt: timestamp("connection_lease_expires_at", { withTimezone: true }),
    connectionEpoch: integer("connection_epoch").notNull().default(0),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_im_bot_bindings_current_agent").on(table.agentId).where(sql`${table.status} <> 'revoked'`),
    uniqueIndex("uq_im_bot_bindings_current_app")
      .on(table.appId)
      .where(sql`${table.status} <> 'revoked' AND ${table.appId} IS NOT NULL`),
    index("idx_im_bot_bindings_org_status").on(table.organizationId, table.status),
    index("idx_im_bot_bindings_connection_claim")
      .on(table.connectionLeaseExpiresAt)
      .where(sql`${table.status} = 'active'`),
    check("chk_im_bot_bindings_status", sql`${table.status} IN ('provisioning', 'active', 'error', 'revoked')`),
    check(
      "chk_im_bot_bindings_connection_status",
      sql`${table.connectionStatus} IN ('disconnected', 'connecting', 'connected', 'error')`,
    ),
    check("chk_im_bot_bindings_connection_epoch", sql`${table.connectionEpoch} >= 0`),
    check(
      "chk_im_bot_bindings_active",
      sql`${table.status} <> 'active' OR (${table.appId} IS NOT NULL AND ${table.botOpenId} IS NOT NULL AND ${table.appSecretCipher} IS NOT NULL AND ${table.registrationStateCipher} IS NULL)`,
    ),
    check(
      "chk_im_bot_bindings_revoked",
      sql`${table.status} <> 'revoked' OR (${table.appSecretCipher} IS NULL AND ${table.registrationStateCipher} IS NULL AND ${table.connectionOwnerInstanceId} IS NULL AND ${table.connectionLeaseExpiresAt} IS NULL AND ${table.connectionStatus} = 'disconnected' AND ${table.revokedAt} IS NOT NULL)`,
    ),
    check(
      "chk_im_bot_bindings_lease_owner",
      sql`(${table.connectionOwnerInstanceId} IS NULL AND ${table.connectionLeaseExpiresAt} IS NULL) OR (${table.connectionOwnerInstanceId} IS NOT NULL AND ${table.connectionLeaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);
