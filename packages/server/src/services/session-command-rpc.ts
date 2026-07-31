import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { clients } from "../db/schema/clients.js";

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

export type SessionCommandRpcResult = {
  command: "session:terminate";
  agentId: string;
  chatId: string;
  applied: boolean;
};

type RpcEntry = SessionCommandRpcResult & { storedAt: string };

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
  const storedMs = Date.parse(row.storedAt);
  if (!Number.isFinite(storedMs) || Date.now() - storedMs >= SESSION_COMMAND_RPC_MAX_AGE_MS) return null;
  return {
    command: "session:terminate",
    agentId: row.agentId,
    chatId: row.chatId,
    applied: row.applied,
    storedAt: row.storedAt,
  };
}

/**
 * Persist one apply-ack ref iff this replica still owns the client row.
 * Returns false when `instance_id` no longer matches (takeover) or the row is
 * gone. Physically prunes aged/excess refs in the same statement.
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
  const entry = { ...result, storedAt: new Date().toISOString() };
  const maxAgeSeconds = Math.floor(SESSION_COMMAND_RPC_MAX_AGE_MS / 1000);
  // One UPDATE: ownership guard + merge ref + physical prune (age then newest N).
  // Column refs in SET are the pre-update row; concurrent UPDATEs serialize on the row.
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
    .where(and(eq(clients.id, clientId), eq(clients.instanceId, expectedInstanceId)))
    .returning({ id: clients.id });
  return returned.length > 0;
}

/** Load a previously stored apply-ack when still within the logical TTL. */
export async function readSessionCommandRpcResult(
  db: Database,
  clientId: string,
  ref: string,
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
  const { command, agentId, chatId, applied } = entry;
  return { command, agentId, chatId, applied };
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
