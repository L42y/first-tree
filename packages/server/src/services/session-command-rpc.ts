import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";

/**
 * The ONE authoritative route + capability condition for the chat-session
 * Reset apply-ack path, shared by the chat status projection, the
 * waitForApply preflight, the cross-replica command forward, and the durable
 * ack store. Every column must agree — an agent whose durable binding,
 * presence route, and connected client row do not line up (stale presence,
 * takeover in flight) must fail closed:
 *
 *   - `agents.status = 'active'` and `agents.client_id` set;
 *   - `agent_presence.status = 'online'` with `client_id = agents.client_id`;
 *   - `clients.status = 'connected'` with `instance_id = agent_presence.instance_id` (both non-null).
 */
export type ApplyAckRouteRow = {
  agentClientId: string | null;
  agentStatus: string;
  presenceStatus: string;
  presenceClientId: string | null;
  presenceInstanceId: string | null;
  clientStatus: string;
  clientInstanceId: string | null;
};

export function isConsistentAgentRoute(row: ApplyAckRouteRow): row is ApplyAckRouteRow & {
  agentClientId: string;
  presenceClientId: string;
  presenceInstanceId: string;
  clientInstanceId: string;
} {
  return (
    row.agentStatus === "active" &&
    row.agentClientId != null &&
    row.agentClientId === row.presenceClientId &&
    row.presenceStatus === "online" &&
    row.presenceInstanceId != null &&
    row.clientStatus === "connected" &&
    row.clientInstanceId != null &&
    row.clientInstanceId === row.presenceInstanceId
  );
}

function wireCapabilities(metadata: unknown): Record<string, unknown> | undefined {
  return (metadata as Record<string, unknown> | null)?.wireCapabilities as Record<string, unknown> | undefined;
}

/** The `wsSessionTerminateApplyAck` flag out of a `clients.metadata` blob. */
export function metadataHasApplyAckCapability(metadata: unknown): boolean {
  return wireCapabilities(metadata)?.wsSessionTerminateApplyAck === true;
}

/** The `wsSessionResetFinalizeHandshake` flag out of a `clients.metadata` blob. */
export function metadataHasResetFinalizeHandshakeCapability(metadata: unknown): boolean {
  return wireCapabilities(metadata)?.wsSessionResetFinalizeHandshake === true;
}

/**
 * The ONE capability verdict for chat-session Reset. Both halves are
 * required: the apply-ack proves the client dropped the provider mapping, and
 * the finalize handshake proves it will release its parked inbox recovery and
 * answer the post-finalize signal. A client that declares only the apply-ack
 * would park its intervening rows behind a fence this server lifts with a
 * frame the client never answers, so Reset must stay hidden and fail closed
 * BEFORE anything destructive is applied locally.
 */
export function metadataSupportsSessionReset(metadata: unknown): boolean {
  return metadataHasApplyAckCapability(metadata) && metadataHasResetFinalizeHandshakeCapability(metadata);
}

/**
 * DB-authoritative route for one agent: consistent route (see
 * `isConsistentAgentRoute`) plus the registered apply-ack capability.
 * `null` when the route is inconsistent or the agent row is missing.
 */
export async function resolveAgentApplyAckRoute(
  db: Database,
  agentId: string,
): Promise<{ clientId: string; instanceId: string; capable: boolean } | null> {
  const [row] = await db
    .select({
      agentClientId: agents.clientId,
      agentStatus: agents.status,
      presenceStatus: agentPresence.status,
      presenceClientId: agentPresence.clientId,
      presenceInstanceId: agentPresence.instanceId,
      clientStatus: clients.status,
      clientInstanceId: clients.instanceId,
      clientMetadata: clients.metadata,
    })
    .from(agents)
    .innerJoin(agentPresence, eq(agentPresence.agentId, agents.uuid))
    .innerJoin(clients, eq(clients.id, agentPresence.clientId))
    .where(eq(agents.uuid, agentId))
    .limit(1);
  if (!row || !isConsistentAgentRoute(row)) return null;
  return {
    clientId: row.presenceClientId,
    instanceId: row.clientInstanceId,
    capable: metadataSupportsSessionReset(row.clientMetadata),
  };
}

/**
 * SQL predicate guarding that the agent is STILL routed to `clientId` on
 * `instanceId` — durable binding + online presence AND the connected client
 * row must all agree. Embedded in atomic UPDATEs and the cross-replica
 * fan-out so a takeover (e.g. `clients.instance_id` moved to another
 * replica while the old presence route and process-local binding linger)
 * cannot land state or deliver a destructive command.
 */
export function agentRouteGuardSql(agentId: string, clientId: string, instanceId: string) {
  return sql`EXISTS (
    SELECT 1 FROM ${agents}
    INNER JOIN ${agentPresence} ON ${agentPresence.agentId} = ${agents.uuid}
    INNER JOIN ${clients} ON ${clients.id} = ${agents.clientId}
    WHERE ${agents.uuid} = ${agentId}
      AND ${agents.status} = 'active'
      AND ${agents.clientId} = ${clientId}
      AND ${agentPresence.status} = 'online'
      AND ${agentPresence.clientId} = ${clientId}
      AND ${agentPresence.instanceId} = ${instanceId}
      AND ${clients.status} = 'connected'
      AND ${clients.instanceId} = ${instanceId}
  )`;
}

/** True when the agent is still routed to this client/instance right now. */
export async function agentRoutedTo(
  db: Database,
  agentId: string,
  clientId: string,
  instanceId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ agentId: agents.uuid })
    .from(agents)
    .where(and(eq(agents.uuid, agentId), agentRouteGuardSql(agentId, clientId, instanceId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Durable rendezvous for the chat-session Reset apply-ack across replicas.
 *
 * The HTTP replica that accepted `terminate?waitForApply=true` usually does
 * NOT own the daemon WebSocket, so the client's `session:command:applied`
 * frame lands on another process. The socket-owning replica stores the small
 * ack under `clients.metadata.sessionCommandRpc[ref]` with an atomic
 * top-level `jsonb_set` (sibling keys stay intact), a nested merge for the
 * ref, and physical prune of aged/excess entries in the same UPDATE.
 * Ownership is enforced in that UPDATE (`id` + expected `instance_id`) so a
 * takeover between check and write cannot persist a stale ack. PG NOTIFY
 * then wakes the HTTP replica's local waiter; on a lost wake the waiter
 * falls back to one durable read before failing.
 */

const RPC_METADATA_KEY = "sessionCommandRpc";

/** Physical TTL for rendezvous entries (also applied on read). */
export const SESSION_COMMAND_RPC_MAX_AGE_MS = 120_000;
/** Cap on retained refs per client after each successful store. */
export const SESSION_COMMAND_RPC_MAX_ENTRIES = 20;

const REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which half of the Reset handshake an entry records. `applied` is the
 * pre-finalize apply-ack; `finalized` is the client's post-finalize receipt,
 * stored under its own rendezvous ref so the two can never satisfy each
 * other's waiter. Legacy entries without the field read back as `applied`.
 */
export type SessionCommandRpcPhase = "applied" | "finalized";

export type SessionCommandRpcResult = {
  command: "session:terminate";
  agentId: string;
  chatId: string;
  applied: boolean;
  phase?: SessionCommandRpcPhase;
};

type RpcEntry = SessionCommandRpcResult & { phase: SessionCommandRpcPhase; storedAt: string };

function asRpcEntry(raw: unknown): RpcEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (
    row.command !== "session:terminate" ||
    typeof row.agentId !== "string" ||
    typeof row.chatId !== "string" ||
    typeof row.applied !== "boolean" ||
    typeof row.storedAt !== "string"
  ) {
    return null;
  }
  if (row.phase !== undefined && row.phase !== "applied" && row.phase !== "finalized") return null;
  const storedMs = Date.parse(row.storedAt);
  if (!Number.isFinite(storedMs) || Date.now() - storedMs >= SESSION_COMMAND_RPC_MAX_AGE_MS) return null;
  return {
    command: "session:terminate",
    agentId: row.agentId,
    chatId: row.chatId,
    applied: row.applied,
    phase: (row.phase as SessionCommandRpcPhase | undefined) ?? "applied",
    storedAt: row.storedAt,
  };
}

/**
 * Persist one apply-ack ref iff this replica still owns the client row AND
 * the agent is still routed to this client/instance (durable binding +
 * online presence). Returns false when `instance_id` no longer matches
 * (takeover), the agent's route moved, or the row is gone. Physically prunes
 * aged/excess refs in the same statement.
 */
export async function storeSessionCommandRpcResult(
  db: Database,
  clientId: string,
  ref: string,
  result: SessionCommandRpcResult,
  expectedInstanceId: string,
): Promise<boolean> {
  if (!REF_RE.test(ref)) {
    throw new Error(`Invalid session-command RPC ref: ${ref}`);
  }
  const entry = { ...result, phase: result.phase ?? "applied", storedAt: new Date().toISOString() };
  const maxAgeSeconds = Math.floor(SESSION_COMMAND_RPC_MAX_AGE_MS / 1000);
  // One UPDATE: ownership + agent-route guards + merge ref + physical prune
  // (age then newest N). Column refs in SET are the pre-update row;
  // concurrent UPDATEs serialize on the row.
  const returned = await db
    .update(clients)
    .set({
      metadata: sql`jsonb_set(
        COALESCE(${clients.metadata}, '{}'::jsonb),
        '{sessionCommandRpc}',
        (
          SELECT COALESCE(jsonb_object_agg(kept.key, kept.value), '{}'::jsonb)
          FROM (
            SELECT e.key, e.value
            FROM jsonb_each(
              COALESCE(${clients.metadata} -> 'sessionCommandRpc', '{}'::jsonb)
              || jsonb_build_object(${ref}::text, ${JSON.stringify(entry)}::jsonb)
            ) AS e(key, value)
            WHERE COALESCE((e.value->>'storedAt')::timestamptz, '-infinity'::timestamptz)
              > now() - make_interval(secs => ${maxAgeSeconds})
            ORDER BY (e.value->>'storedAt')::timestamptz DESC NULLS LAST
            LIMIT ${SESSION_COMMAND_RPC_MAX_ENTRIES}
          ) AS kept
        ),
        true
      )`,
    })
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.instanceId, expectedInstanceId),
        agentRouteGuardSql(result.agentId, clientId, expectedInstanceId),
      ),
    )
    .returning({ id: clients.id });
  return returned.length > 0;
}

/**
 * Load a previously stored handshake result when still within the logical
 * TTL. `expectedPhase` fails closed on a phase mismatch so a finalize waiter
 * can never settle on a leftover apply-ack.
 */
export async function readSessionCommandRpcResult(
  db: Database,
  clientId: string,
  ref: string,
  expectedPhase?: SessionCommandRpcPhase,
): Promise<SessionCommandRpcResult | null> {
  const [client] = await db
    .select({ metadata: clients.metadata })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return null;
  const base = (client.metadata ?? {}) as Record<string, unknown>;
  const map = base[RPC_METADATA_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const entry = asRpcEntry((map as Record<string, unknown>)[ref]);
  if (!entry) return null;
  if (expectedPhase !== undefined && entry.phase !== expectedPhase) return null;
  const { command, agentId, chatId, applied, phase } = entry;
  return { command, agentId, chatId, applied, phase };
}

/** Raw rendezvous key count (including aged entries) — test/observability seam. */
export async function countSessionCommandRpcKeys(db: Database, clientId: string): Promise<number> {
  const [client] = await db
    .select({ metadata: clients.metadata })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client?.metadata || typeof client.metadata !== "object") return 0;
  const map = (client.metadata as Record<string, unknown>)[RPC_METADATA_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return 0;
  return Object.keys(map as Record<string, unknown>).length;
}
