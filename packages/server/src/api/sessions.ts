import type { SessionCommandAbortReason } from "@first-tree/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ConflictError, ServiceUnavailableError } from "../errors.js";
import { requireAgentAccess, requireChatAccess } from "../scope/require-resource.js";
import * as agentService from "../services/agents/identity.js";
import * as sessionEventService from "../services/chat/sessions/events.js";
import * as sessionService from "../services/chat/sessions/lifecycle.js";
import * as connectionManager from "../services/connection-manager.js";
import { sendToAgent } from "../services/connection-manager.js";
import { readSessionCommandRpcResult, resolveAgentApplyAckRoute } from "../services/session-command-rpc.js";

const sessionFilterSchema = z.object({
  state: z.enum(["active", "suspended", "evicted"]).optional(),
  runtimeState: z.enum(["idle", "working", "blocked", "error"]).optional(),
});

/** Class C — per-resource session routes (`/api/v1/agents/:uuid/sessions/...`). */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /** GET /agents/:uuid/sessions — sessions for one agent. */
  app.get<{ Params: { uuid: string } }>("/:uuid/sessions", async (request) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "visible");
    const filters = sessionFilterSchema.parse(request.query);
    const isManager = agent.managerId === scope.memberId;
    const sessions = await sessionService.listAgentSessions(app.db, agent.uuid, filters);
    if (isManager || scope.role === "admin") return sessions;
    return sessionService.filterSessionsByParticipant(app.db, sessions, scope.humanAgentId);
  });

  /** GET /agents/:uuid/sessions/:chatId — session detail (gated on both agent visibility AND chat access). */
  app.get<{ Params: { uuid: string; chatId: string } }>("/:uuid/sessions/:chatId", async (request) => {
    const { agent } = await requireAgentAccess(request, app.db, "visible");
    // Bind chatId for the chat-access helper.
    await requireChatAccess(request, app.db);
    return sessionService.getSession(app.db, agent.uuid, request.params.chatId);
  });

  /** Session events stream. */
  app.get<{
    Params: { uuid: string; chatId: string };
    Querystring: { limit?: string; cursor?: string; direction?: string };
  }>("/:uuid/sessions/:chatId/events", async (request) => {
    const { agent } = await requireAgentAccess(request, app.db, "visible");
    await requireChatAccess(request, app.db);
    const limit = request.query.limit !== undefined ? Number.parseInt(request.query.limit, 10) : undefined;
    const cursor = request.query.cursor !== undefined ? Number.parseInt(request.query.cursor, 10) : undefined;
    const direction = request.query.direction === "desc" ? "desc" : "asc";
    return sessionEventService.listEvents(app.db, agent.uuid, request.params.chatId, {
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: Number.isFinite(cursor) ? cursor : undefined,
      direction,
    });
  });

  app.post<{ Params: { uuid: string; chatId: string } }>("/:uuid/sessions/:chatId/suspend", async (request, reply) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
    const result = await sessionService.suspendSession(
      app.db,
      agent.uuid,
      request.params.chatId,
      scope.organizationId,
      app.notifier,
    );
    // Send on the already-suspended path too, not only on a fresh transition:
    // a client that was disconnected when the first command fired must be
    // able to converge through an idempotent retry of the same endpoint.
    // `delivered` lets callers (e.g. the Web Reset flow) fail honestly when
    // the DB moved but the command never reached the client.
    const delivered =
      result.state === "suspended"
        ? sendToAgent(agent.uuid, { type: "session:suspend", chatId: request.params.chatId })
        : true;
    return reply.status(200).send({
      agentId: agent.uuid,
      chatId: request.params.chatId,
      state: result.state,
      transitioned: result.transitioned,
      delivered,
    });
  });

  app.post<{ Params: { uuid: string; chatId: string } }>("/:uuid/sessions/:chatId/resume", async (request, reply) => {
    const { agent } = await requireAgentAccess(request, app.db, "manage");
    const session = await sessionService.getSession(app.db, agent.uuid, request.params.chatId);
    if (session.state === "suspended") {
      const delivered = sendToAgent(agent.uuid, { type: "session:resume", chatId: request.params.chatId });
      if (!delivered) {
        throw new ServiceUnavailableError("Resume command was not delivered because the agent client is disconnected");
      }
    }
    return reply.status(200).send({
      agentId: agent.uuid,
      chatId: request.params.chatId,
      state: session.state,
      transitioned: false,
    });
  });

  app.post<{ Params: { uuid: string; chatId: string }; Querystring: { waitForApply?: string } }>(
    "/:uuid/sessions/:chatId/terminate",
    async (request, reply) => {
      const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
      if (request.query.waitForApply === "true") {
        return terminateWithApplyAck(app, request, reply, agent.uuid, scope.organizationId);
      }
      const result = await sessionService.archiveSession(
        app.db,
        agent.uuid,
        request.params.chatId,
        scope.organizationId,
        app.notifier,
      );
      if (result.state === "evicted") {
        // Awaited, not fire-and-forget: the Web Reset flow refetches session
        // events as soon as this response arrives, so a success response must
        // not race the trace cleanup. Runs on the idempotent already-evicted
        // path too, so a retry after a cleanup failure still completes it. A
        // cleanup failure rejects the request instead of pretending success.
        await sessionEventService.clearEvents(app.db, agent.uuid, request.params.chatId);
      }
      // Same idempotent-retry contract as suspend: an already-evicted row
      // still re-sends `session:terminate` so a client that missed the first
      // command converges. The active no-op sends nothing. `delivered`
      // exposes whether the command actually reached the client.
      const delivered =
        result.state === "evicted"
          ? sendToAgent(agent.uuid, { type: "session:terminate", chatId: request.params.chatId })
          : true;
      return reply.status(200).send({
        agentId: agent.uuid,
        chatId: request.params.chatId,
        state: result.state,
        transitioned: result.transitioned,
        delivered,
      });
    },
  );

  // Service helper to keep the orgs/sessions.ts list endpoint flexible:
  // unused here but keeps a friendly export for the agent service module.
  void agentService;
}

/**
 * `POST .../terminate?waitForApply=true` — the Web chat-session Reset path.
 *
 * Success requires the client to APPLY the terminate, not just receive the
 * frame: preflight the stopped-session state and the DB-authoritative client
 * route (connected + owning instance + apply-ack capability), send a ref'd
 * `session:terminate` (direct when this replica owns the daemon socket, PG
 * NOTIFY fan-out otherwise), wait for the matching `session:command:applied`
 * ack, and only then atomically evict + clear traces
 * (`finalizeTerminatedSession`), then confirm that finalization with the
 * client (see {@link confirmResetFinalization}) before reporting success. The ack is also persisted by the
 * socket-owning replica, so a lost result wake falls back to one durable
 * read.
 *
 * Accepting `applied: true` arms a Reset generation on the client that only an
 * exact receipted disposition can lift, so from that point every exit — not
 * just the success path — must complete one. A branch that fails to commit the
 * eviction (reactivation, the finalize transaction's route refusal, a
 * rolled-back trace cleanup) confirms an ABORT for the same `ref` (see
 * {@link confirmResetAbort}) before returning its 409/500. Abort does not
 * restore the retired provider session; it only lifts that generation so the
 * durable unACKed row recovers once into a fresh provider session. An HTTP 200
 * still requires both a durable eviction and a matching finalize receipt.
 *
 * The preflight capability verdict is a snapshot, so it is NOT the only
 * capability gate: the composite `wsSessionResetV1` flag is revalidated
 * again at command delivery (live socket here, live socket + DB route on the
 * cross-replica fan-out) and once more when the apply-ack is made durable.
 * Only the post-apply terminal dispositions (`finalized` and `aborted`) stay
 * identity-scoped — original applying Client identity, no live Reset-capability
 * re-gate — so a client that already applied can always be released.
 *
 * Every failure — offline/incapable client, send failure,
 * disconnect/timeout while waiting, `applied:false`, or a state change
 * during the wait — rejects the request WITHOUT touching the session row, so
 * the session stays stopped and Reset remains retryable after a reconnect or
 * page reload. An already-`evicted` row still re-runs the acknowledged
 * terminate: an earlier legacy eviction is not proof the current client
 * dropped its provider-session mapping. There is deliberately no fallback to
 * the legacy fire-and-forget path inside this mode.
 */
async function terminateWithApplyAck(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: { uuid: string; chatId: string } }>,
  reply: FastifyReply,
  agentId: string,
  organizationId: string,
): Promise<FastifyReply> {
  const chatId = request.params.chatId;
  const session = await sessionService.getSession(app.db, agentId, chatId);

  if (session.state === "active") {
    // Active sessions are never reset: the operator must pause the agent
    // first, so a running turn is never torn down through Reset.
    throw new ConflictError("Session must be suspended or errored before it can be reset");
  }

  // DB-authoritative route (shared predicate): durable agent binding +
  // online presence + connected client must all agree on client/instance,
  // and the client must have registered the composite `wsSessionResetV1`
  // capability — a legacy apply-only client is refused here, before any
  // destructive command is sent. Any replica reaches the same verdict,
  // independent of socket ownership.
  const route = await resolveAgentApplyAckRoute(app.db, agentId);
  if (!route) {
    throw new ServiceUnavailableError("The agent's client is disconnected");
  }
  if (!route.capable) {
    throw new ServiceUnavailableError(
      "The agent's client does not support this version of the Reset protocol; Reset is unavailable",
    );
  }
  const clientId = route.clientId;
  const targetInstanceId = route.instanceId;

  // Register the waiter BEFORE the command can be delivered so a fast ack
  // can never be missed.
  const ref = crypto.randomUUID();
  const waiter = connectionManager.waitForClientReply(clientId, ref);
  if (targetInstanceId === app.config.instanceId) {
    // Same-replica path — the command semantics are identical to the remote
    // fan-out, including the current-binding AND current-capability checks.
    // Identity alone is not enough: the preflight's capability verdict is a
    // DB read taken before the send, and the same clientId on the same
    // instance can have reconnected as a legacy build in between
    // (`client:register` replaces `wireCapabilities` wholesale). Such a
    // client would destroy its provider session on the terminate and then
    // park intervening rows behind a fence it never lifts, so re-check the
    // LIVE socket's capability and fail closed.
    if (
      connectionManager.getAgentClientId(agentId) !== clientId ||
      !connectionManager.agentSupportsSessionResetV1(agentId) ||
      !sendToAgent(agentId, { type: "session:terminate", chatId, ref })
    ) {
      // Nobody will `await` this waiter on the failure path, so absorb the
      // cancellation before rejecting it.
      waiter.catch(() => undefined);
      connectionManager.cancelClientReply(clientId, ref, new Error("send failed"));
      throw new ServiceUnavailableError("The terminate command could not be delivered to the agent's client");
    }
  } else {
    await app.notifier.notifyDaemonClientCommand({
      type: "session:terminate",
      clientId,
      agentId,
      chatId,
      ref,
      targetInstanceId,
    });
  }

  let ack: unknown;
  try {
    ack = await waiter;
  } catch (err) {
    // Race-safe fallback: the ack may already be durable while the wake was lost.
    const stored = await readSessionCommandRpcResult(app.db, clientId, ref).catch(() => null);
    if (stored) {
      ack = stored;
    } else {
      throw new ServiceUnavailableError(
        `The agent's client did not confirm the terminate: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const ackFrame = ack as { command?: string; agentId?: string; chatId?: string; applied?: boolean };
  if (
    ackFrame.command !== "session:terminate" ||
    ackFrame.agentId !== agentId ||
    ackFrame.chatId !== chatId ||
    ackFrame.applied !== true
  ) {
    throw new ServiceUnavailableError("The agent's client failed to apply the terminate");
  }

  // From here on the client has TRUTHFULLY applied: its provider session is
  // durably gone and its Reset generation for `ref` is armed, so EVERY exit
  // below owes that exact generation one receipted disposition before an HTTP
  // outcome is reported. `finalized` is the disposition for a committed
  // eviction; `aborted` is the disposition for every branch that does not
  // commit one. Without it a throwing branch answers the operator with 409/500
  // and leaves the chat fenced forever behind a fence nobody will lift.
  const dispositionRoute = { agentId, chatId, ref, clientId, targetInstanceId };
  let evictedCommitted = false;
  let dispositionSettled = false;
  try {
    const result = await sessionService.finalizeTerminatedSession(
      app.db,
      agentId,
      chatId,
      organizationId,
      app.notifier,
      { clientId, instanceId: targetInstanceId },
    );
    if (result.state !== "evicted") {
      // A new message re-activated the session while the ack was in flight —
      // do not evict or clear the fresh session, but DO lift the generation the
      // client armed, so its parked row enters a fresh provider session instead
      // of waiting on a finalize that will never come.
      dispositionSettled = true;
      await confirmResetAbort(app, dispositionRoute, "reactivated");
      throw new ConflictError("The session became active again while waiting for the client; nothing was reset");
    }
    evictedCommitted = true;
    dispositionSettled = true;
    await confirmResetFinalization(app, dispositionRoute);
    return reply
      .status(200)
      .send({ agentId, chatId, state: "evicted", transitioned: result.transitioned, delivered: true, applied: true });
  } catch (err) {
    // `evictedCommitted` splits the two truths precisely. Before the commit
    // there is no eviction to finalize, so the armed generation must be
    // ABORTED — this covers the route refusal thrown by the finalize
    // transaction's last-in-transaction revalidation and a rolled-back
    // evict + trace-clear transaction alike. After the commit the eviction is
    // durable and `finalized` is the only honest disposition, so a failure
    // there stays a plain 503 and converges through the operator's retried
    // Reset (a new terminate ref against the already-evicted row).
    if (!evictedCommitted && !dispositionSettled) {
      try {
        await confirmResetAbort(
          app,
          dispositionRoute,
          err instanceof ConflictError ? "route_refused" : "cleanup_failed",
        );
      } catch (abortErr) {
        // Both halves failed. Report the abort failure rather than the original
        // cause: a chat still fenced behind an unlifted Reset generation is the
        // worse and far less obvious outcome, and the cause stays in the log.
        request.log.warn(
          { err, abortErr, agentId, chatId, ref },
          "Reset failed and its abort disposition did not converge; the client may still be fenced",
        );
        throw abortErr;
      }
    }
    throw err;
  }
}

type ResetDispositionRoute = {
  agentId: string;
  chatId: string;
  ref: string;
  clientId: string;
  targetInstanceId: string;
};

/**
 * Second half of the Reset handshake, success side: tell the daemon client that
 * finalization is durable, and hold the request until that exact client
 * confirms it. See {@link confirmResetDisposition} for the shared contract.
 */
function confirmResetFinalization(app: FastifyInstance, route: ResetDispositionRoute): Promise<void> {
  return confirmResetDisposition(app, route, {
    phase: "finalized",
    frame: { type: "session:command:finalized", state: "evicted" },
    sendFailedMessage: "The session was reset but the client could not be told; it may still be holding queued work",
    noReceiptMessage: "The session was reset but the client did not confirm it",
    mismatchMessage: "The session was reset but the client's confirmation did not match",
  });
}

/**
 * Second half of the Reset handshake, failure side: tell the daemon client that
 * this Reset generation is lifted WITHOUT an eviction, and hold the request
 * until that exact client confirms it.
 *
 * Every server branch that accepted a truthful `applied: true` and then failed
 * to commit the eviction goes through here. Aborting does not resurrect the
 * retired provider mapping or the old session — that mapping is durably gone —
 * it only lifts the one armed generation so the durable unACKed row recovers
 * once into a fresh nonce-derived provider session. Stale, foreign, superseded,
 * or duplicate refs are answered `released: false` by the client's own
 * generation authority, so a late abort can never lift a newer Reset's fence.
 */
function confirmResetAbort(
  app: FastifyInstance,
  route: ResetDispositionRoute,
  reason: SessionCommandAbortReason,
): Promise<void> {
  return confirmResetDisposition(app, route, {
    phase: "aborted",
    frame: { type: "session:command:aborted", reason },
    sendFailedMessage:
      "The session was not reset and the client could not be told; it may still be holding queued work",
    noReceiptMessage: "The session was not reset and the client did not confirm the abort",
    mismatchMessage: "The session was not reset and the client's abort confirmation did not match",
  });
}

/**
 * Deliver one post-apply disposition to the client that applied the terminate,
 * and hold the request until that client's receipt lands.
 *
 * A fire-and-forget frame is not enough. The client keeps intervening inbox
 * rows parked behind its Reset admission fence until an exact disposition for
 * that generation arrives, so a dropped frame (or a dropped PG wake) would
 * leave the operator with an HTTP outcome over a chat that can no longer make
 * progress. The receipt therefore uses the same correlated waiter plus durable
 * rendezvous fallback as the apply-ack, because `notifyDaemonClientCommand`
 * still swallows publish failures.
 *
 * The receipt is correlated on a FRESH `ackRef`, not the terminate `ref`: the
 * apply-ack's cross-replica result wake for `ref` can still be in flight and
 * would otherwise resolve this waiter with the wrong phase.
 *
 * Delivery is addressed to the ORIGINAL applying `clientId` — `sendToClient`,
 * never `sendToAgent`. The agent's process-local binding can move after a
 * truthful apply (that is precisely when `aborted` fires), and following it
 * would either deliver this client's fence release to a replacement client or
 * fail closed and strand the applying client behind a fence nobody else can
 * lift. `sendToClient` can only ever reach the one identity that armed the
 * generation, so there is no wrong-socket hazard left to guard against.
 *
 * This phase is also deliberately identity-only on capability — no
 * `wsSessionResetV1` revalidation. Both frames are non-destructive (they lift a
 * fence the client armed itself) and are only ever sent after a genuinely
 * capable client already applied. Re-gating on a flag that flipped between
 * apply and receipt would leave that client fenced with no way to converge; a
 * client that truly cannot answer still fails the request through the receipt
 * waiter rather than a capability check.
 */
async function confirmResetDisposition(
  app: FastifyInstance,
  route: ResetDispositionRoute,
  disposition: {
    phase: "finalized" | "aborted";
    frame:
      | { type: "session:command:finalized"; state: "evicted" }
      | { type: "session:command:aborted"; reason: SessionCommandAbortReason };
    sendFailedMessage: string;
    noReceiptMessage: string;
    mismatchMessage: string;
  },
): Promise<void> {
  const { agentId, chatId, ref, clientId, targetInstanceId } = route;
  const ackRef = crypto.randomUUID();
  const waiter = connectionManager.waitForClientReply(clientId, ackRef);

  if (targetInstanceId === app.config.instanceId) {
    if (
      !connectionManager.sendToClient(clientId, {
        ...disposition.frame,
        ref,
        ackRef,
        agentId,
        chatId,
        command: "session:terminate",
      })
    ) {
      waiter.catch(() => undefined);
      connectionManager.cancelClientReply(clientId, ackRef, new Error("send failed"));
      throw new ServiceUnavailableError(disposition.sendFailedMessage);
    }
  } else {
    await app.notifier.notifyDaemonClientCommand({
      ...(disposition.frame.type === "session:command:aborted"
        ? { type: disposition.frame.type, reason: disposition.frame.reason }
        : { type: disposition.frame.type }),
      clientId,
      agentId,
      chatId,
      ref,
      ackRef,
      targetInstanceId,
    });
  }

  let receipt: unknown;
  try {
    receipt = await waiter;
  } catch (err) {
    const stored = await readSessionCommandRpcResult(app.db, clientId, ackRef, disposition.phase).catch(() => null);
    if (stored) {
      receipt = stored;
    } else {
      throw new ServiceUnavailableError(
        `${disposition.noReceiptMessage}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const receiptFrame = receipt as {
    command?: string;
    agentId?: string;
    chatId?: string;
    phase?: string;
    applied?: boolean;
  };
  if (
    receiptFrame.command !== "session:terminate" ||
    receiptFrame.agentId !== agentId ||
    receiptFrame.chatId !== chatId ||
    receiptFrame.phase !== disposition.phase ||
    receiptFrame.applied !== true
  ) {
    throw new ServiceUnavailableError(disposition.mismatchMessage);
  }
}
