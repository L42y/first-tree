import {
  type ClientMessage,
  hasTeamSkillInvocationMarker,
  isImageBatchRefContent,
  type Message,
  messageSourceSchema,
  type ParticipantMode,
  type PrecedingMessage,
  supportsTeamSkillInvocationClientVersion,
  TEAM_SKILL_INVOCATION_UNSUPPORTED_CLIENT_NOTICE,
} from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentConfigs } from "../../db/schema/agent-configs.js";
import { agentPresence } from "../../db/schema/agent-presence.js";
import { agents } from "../../db/schema/agents.js";
import { clients } from "../../db/schema/clients.js";
import { isConsistentAgentRoute } from "../runtime/rpc/session-command.js";

/**
 * Use a structurally-typed DB so both `Database` and `PgTransaction` from
 * `db.transaction(...)` callbacks are accepted.
 */
type DbLike = Pick<PostgresJsDatabase<Record<string, never>>, "select">;

/**
 * Loose shape for inbound message rows. `source` is plain text in DB and may
 * be NULL on rows that pre-date migration 0047 (where the column was made
 * NOT NULL); we still normalise defensively below in case an older replica
 * lags or a test fixture seeds an unbounded row.
 */
type RawMessageRow = Omit<Message, "source" | "senderKind" | "senderProvider" | "configVersion" | "recipientMode"> & {
  source: string | null;
  senderKind?: Message["senderKind"];
  senderProvider?: Message["senderProvider"];
};

function normaliseSource(source: string | null): Message["source"] {
  if (source === null) return null;
  const parsed = messageSourceSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
}

/**
 * v2: chat_membership.mode is decision-inert. The wire field `recipientMode`
 * (and the parallel `mode` field on chat-detail / participant payloads) is
 * retained on the protocol for backwards compatibility with already-deployed
 * client runtimes — server writes the constant `"mention_only"` and every
 * consumer ignores it. Drop together with the DB column once all clients are
 * on a post-v2 release (see proposals/hub-chat-message-v2-simplify-mode.20260520.md §七).
 *
 * Exported so chat-detail / participant-list wire-payload builders in
 * `services/chat/conversation.ts` + `api/chats.ts` use the same constant and the v3
 * cleanup is one grep away.
 */
export const WIRE_RECIPIENT_MODE: ParticipantMode = "mention_only";

/**
 * Single entry point for "DB message row → wire payload sent to client runtime".
 *
 * Step 3 (M1 §10 risk 3): every code path that puts a message on the wire to
 * a client must funnel through here so `configVersion` is always present and
 * always reflects the current `agent_configs.version`.
 *
 * Inputs may be either an `inboxId` (inbox claim paths — push and the debug
 * `GET /inbox`) or an `agentId` (direct-send paths). Both resolve to the
 * same agent-config lookup.
 *
 * `entryChatId` is the chat this payload is routed to on the receiver side
 * — typically equal to `message.chatId`. v2 made `recipientMode` a constant
 * wire value (decision-inert), so the parameter is currently unused but
 * retained on the signature for downstream parity / future re-use.
 *
 * Production code should prefer `buildClientMessagePayloadsForInbox` — the
 * single-message variant is kept only because it simplifies the dispatcher
 * unit tests. Each call here issues one independent query (agent-config),
 * so batching still matters for any fan-out sized path; v2 retired the
 * separate chat_membership.mode lookup that used to be the second query.
 */
export type ClientMessagePayloadSource = { kind: "inboxId"; inboxId: string } | { kind: "agentId"; agentId: string };

/**
 * Rollout gate at the DB-row→wire boundary: the connected client's
 * `sdk_version` under the current route-consistent binding, or null when
 * the route is inconsistent / unbound / offline. A marker-carrying message
 * must never reach a client that cannot resolve the marker fail-closed —
 * it would ignore the marker and run the base literal as a local Skill.
 */
async function resolveRouteSdkVersion(db: DbLike, agentId: string): Promise<string | null> {
  const [route] = await db
    .select({
      agentClientId: agents.clientId,
      agentStatus: agents.status,
      presenceStatus: agentPresence.status,
      presenceClientId: agentPresence.clientId,
      presenceInstanceId: agentPresence.instanceId,
      clientStatus: clients.status,
      clientInstanceId: clients.instanceId,
      clientSdkVersion: clients.sdkVersion,
    })
    .from(agents)
    .innerJoin(agentPresence, eq(agentPresence.agentId, agents.uuid))
    .innerJoin(clients, eq(clients.id, agentPresence.clientId))
    .where(eq(agents.uuid, agentId))
    .limit(1);
  if (!route || !isConsistentAgentRoute(route)) return null;
  return route.clientSdkVersion;
}

/**
 * Wire-only replacement for a marker-carrying message whose current client
 * is too old for the marker protocol: text content and image captions
 * become the inert notice (no leading slash token), attachments and every
 * other field pass through untouched. The stored DB row is never mutated —
 * only this payload changes. Captionless batches and unknown structures
 * carry no command position and pass through as-is.
 */
function contentForUnsupportedMarkerClient(content: unknown): unknown {
  if (typeof content === "string") return TEAM_SKILL_INVOCATION_UNSUPPORTED_CLIENT_NOTICE;
  if (isImageBatchRefContent(content) && typeof content.caption === "string") {
    return { ...content, caption: TEAM_SKILL_INVOCATION_UNSUPPORTED_CLIENT_NOTICE };
  }
  return content;
}

export async function buildClientMessagePayload(
  db: DbLike,
  source: ClientMessagePayloadSource,
  message: RawMessageRow,
  _entryChatId?: string | null,
  precedingMessages: PrecedingMessage[] = [],
): Promise<ClientMessage> {
  const agentId = await resolveAgentId(db, source);
  const [cfg] = await db
    .select({ version: agentConfigs.version })
    .from(agentConfigs)
    .where(eq(agentConfigs.agentId, agentId))
    .limit(1);
  // Step 1's seeding guarantees every non-deleted agent has a row; if a
  // bind happens for a deleted agent we still degrade to v=1 rather than
  // throwing — the auth layer would reject the agent first.
  const version = cfg?.version ?? 1;

  // Rollout gate: a message carrying the server-owned Team Skill
  // invocation marker may only reach a client whose version parses the
  // marker fail-closed. The send-time menu gate cannot cover messages
  // already queued when the agent's client rolls back, so the wire
  // boundary re-checks the CURRENT route and swaps the command content
  // for an inert notice (DB row untouched, delivery + ACK proceed — the
  // FIFO never parks behind a rollback).
  const content = hasTeamSkillInvocationMarker(message.metadata)
    ? supportsTeamSkillInvocationClientVersion(await resolveRouteSdkVersion(db, agentId))
      ? message.content
      : contentForUnsupportedMarkerClient(message.content)
    : message.content;

  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    senderKind: message.senderKind ?? "member",
    senderProvider: message.senderProvider ?? null,
    format: message.format,
    content: content as Message["content"],
    metadata: message.metadata,
    inReplyTo: message.inReplyTo,
    source: normaliseSource(message.source),
    createdAt: message.createdAt,
    configVersion: version,
    recipientMode: WIRE_RECIPIENT_MODE,
    precedingMessages,
  };
}

export type MessageForInbox = {
  entryChatId: string | null;
  message: RawMessageRow;
  /** Group-chat context the recipient missed (silent inbox). Empty by default. */
  precedingMessages?: PrecedingMessage[];
};

/**
 * Batch variant — builds all payloads with a single DB lookup per agent.
 * v2 dropped the chat_membership.mode batched lookup; every payload's
 * `recipientMode` is the constant wire value. A caller that already resolved
 * the inbox owner may pass it to keep recipient-bound preprocessing and
 * payload construction on the same two-query path.
 */
export async function buildClientMessagePayloadsForInbox(
  db: DbLike,
  inboxId: string,
  items: MessageForInbox[],
  resolvedAgentId?: string,
): Promise<ClientMessage[]> {
  if (items.length === 0) return [];
  const agentId = resolvedAgentId ?? (await resolveInboxAgentId(db, inboxId));
  const [cfg] = await db
    .select({ version: agentConfigs.version })
    .from(agentConfigs)
    .where(eq(agentConfigs.agentId, agentId))
    .limit(1);
  const version = cfg?.version ?? 1;

  // Rollout gate (see buildClientMessagePayload): resolved ONCE for the
  // whole batch since every item shares this inbox's agent — a
  // marker-carrying message never reaches a client too old to resolve the
  // marker fail-closed; its command content becomes an inert notice on the
  // wire only.
  const markerClientSupported = supportsTeamSkillInvocationClientVersion(await resolveRouteSdkVersion(db, agentId));

  return items.map(({ message: m, precedingMessages = [] }) => ({
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    senderKind: m.senderKind ?? "member",
    senderProvider: m.senderProvider ?? null,
    format: m.format,
    content: (hasTeamSkillInvocationMarker(m.metadata) && !markerClientSupported
      ? contentForUnsupportedMarkerClient(m.content)
      : m.content) as Message["content"],
    metadata: m.metadata,
    inReplyTo: m.inReplyTo,
    source: normaliseSource(m.source),
    createdAt: m.createdAt,
    configVersion: version,
    recipientMode: WIRE_RECIPIENT_MODE,
    precedingMessages,
  }));
}

async function resolveAgentId(db: DbLike, source: ClientMessagePayloadSource): Promise<string> {
  if (source.kind === "agentId") return source.agentId;
  return resolveInboxAgentId(db, source.inboxId);
}

/** Resolve the agent that owns an inbox once for recipient-bound delivery. */
export async function resolveInboxAgentId(db: DbLike, inboxId: string): Promise<string> {
  const [agent] = await db.select({ uuid: agents.uuid }).from(agents).where(eq(agents.inboxId, inboxId)).limit(1);
  if (!agent) {
    throw new Error(`No agent owns inbox "${inboxId}"`);
  }
  return agent.uuid;
}
