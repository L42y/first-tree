import type { RuntimeProvider } from "@first-tree/shared";
import { eq, getTableColumns } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { BadRequestError, ClientRetiredError } from "../errors.js";

type SelectDbLike = Pick<PostgresJsDatabase<Record<string, never>>, "select">;

/**
 * True iff `clients.metadata.capabilities` is a non-empty object — i.e. the
 * client has reported at least one runtime probe result. Used to distinguish
 * "we don't know what's installed yet" (empty / never reported) from
 * "client explicitly reports this provider is missing".
 */
function clientCapabilitiesReported(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const meta = metadata as Record<string, unknown>;
  const caps = meta.capabilities;
  if (!caps || typeof caps !== "object") return false;
  return Object.keys(caps as Record<string, unknown>).length > 0;
}

/**
 * Inspect a `clients.metadata.capabilities` blob (jsonb) for a specific
 * runtime provider entry. Capabilities live under the `metadata.capabilities`
 * subkey (Option C); the column is unstructured at the DB layer, so we
 * defensively narrow before key access.
 *
 * "Supports" requires the entry to be **available** — i.e. `available === true`,
 * which under install-only detection means `state: "ok"` (the binary is
 * installed). A `missing` or `error` entry is *reported* but not installed, so
 * we explicitly reject those rather than treating mere key presence as support.
 * Authentication is no longer probed; a logged-out provider is still `available`
 * (installed) and the login is resolved at session run time via the in-chat
 * needs-login entry, not gated here.
 */
function clientSupportsRuntimeProvider(metadata: unknown, provider: RuntimeProvider): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const meta = metadata as Record<string, unknown>;
  const caps = meta.capabilities;
  if (!caps || typeof caps !== "object") return false;
  const entry = (caps as Record<string, unknown>)[provider];
  if (!entry || typeof entry !== "object") return false;
  const available = (entry as { available?: unknown }).available;
  return available === true;
}

/**
 * Check that a client's reported capabilities show the given runtime provider
 * as **available** (SDK installed, regardless of auth state).
 *
 * Tri-state semantics by `clients.metadata.capabilities` shape:
 *   - empty / absent — client hasn't probed yet (newly registered or pre-P2
 *     install). Treat as "unknown" and allow; the in-band repair path
 *     (RUNTIME_PROVIDER_MISMATCH on bind) catches actual incompatibility.
 *   - reported, entry shows `available: true` (install-only `state: ok`) — allow.
 *   - reported, entry missing OR `state: missing | error` — block unless
 *     `force` is set. We deliberately do NOT treat mere key presence as
 *     support: probeCapabilities() always emits an entry per built-in
 *     provider, including `{ state: "missing" }` for absent SDKs.
 *
 * Skipped entirely for human agents (no clientId) and when `force` is set
 * (e.g. operator overrides for an offline client).
 */
export async function ensureClientSupportsRuntimeProvider(
  db: SelectDbLike,
  clientId: string | null,
  runtimeProvider: RuntimeProvider,
  options: { force?: boolean } = {},
): Promise<void> {
  if (clientId === null) return;
  if (options.force) return;

  const [client] = await db
    .select({ metadata: clients.metadata, retiredAt: clients.retiredAt })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return; // resolveAgentClient validates existence elsewhere
  if (client.retiredAt) {
    throw new ClientRetiredError(`Client "${clientId}" has been retired`);
  }

  // Best-effort: if the client never reported capabilities, allow and let
  // the runtime path catch real mismatches at bind time.
  if (!clientCapabilitiesReported(client.metadata)) return;

  if (!clientSupportsRuntimeProvider(client.metadata, runtimeProvider)) {
    throw new BadRequestError(
      `Client "${clientId}" does not have runtime provider "${runtimeProvider}" available. ` +
        "Install the matching SDK on that machine and re-run capability detection, " +
        "or retry with `force: true` if the client is offline / capabilities are stale.",
    );
  }
}

/**
 * Reusable projection for single-agent reads + mutation responses: every
 * column on `agents` plus `agent_presence.runtimeState` (the M1+ authority
 * for "is this agent running"; NULL when the agent has no presence row
 * yet, i.e. never bound a runtime client).
 *
 * Threading this through `getAgent`, `requireAgentAccess`, and every
 * mutation service is what keeps `runtimeState` on the wire across all
 * single-agent endpoints — see PR #571 review: the previous shape lost
 * the field on `GET /:uuid` and every PATCH/suspend/reactivate
 * response, which made management surfaces (Team / Settings) read a
 * fictitious "offline" state.
 *
 * Returns `null` when no row exists (the caller decides whether that's a
 * 404 or an internal invariant violation post-update).
 */
export async function selectAgentRowWithRuntime(db: SelectDbLike, uuid: string): Promise<AgentRowWithRuntime | null> {
  const [row] = await db
    .select({
      ...getTableColumns(agents),
      runtimeState: agentPresence.runtimeState,
    })
    .from(agents)
    .leftJoin(agentPresence, eq(agents.uuid, agentPresence.agentId))
    .where(eq(agents.uuid, uuid))
    .limit(1);
  return row ?? null;
}

export type AgentRowWithRuntime = typeof agents.$inferSelect & { runtimeState: string | null };
