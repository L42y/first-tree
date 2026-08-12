import { randomUUID } from "node:crypto";
import {
  PROVIDER_MODELS_LIST_TYPE,
  providerModelCatalogSchema,
  RUNTIME_AUTH_START_TYPE,
  RUNTIME_READINESS_CHECK_TYPE,
  runtimeAuthStartRequestSchema,
  runtimeProviderSchema,
  runtimeReadinessStartRequestSchema,
  updateClientCapabilitiesSchema,
} from "@first-tree/shared";
import { getChannelConfig } from "@first-tree/shared/channel";
import type { FastifyInstance } from "fastify";
import { BadGatewayError, BadRequestError, GatewayTimeoutError, ServiceUnavailableError } from "../errors.js";
import { stampClientResource } from "../observability/request-context.js";
import { requireUser } from "../scope/require-user.js";
import { expiryToSeconds } from "../services/auth/tokens.js";
import * as clientService from "../services/runtime/client.js";
import {
  clientSupportsRuntimeReadinessV1,
  forceDisconnectClient,
  rejectPendingRepliesForClient,
  sendToClient,
  waitForClientReply,
} from "../services/runtime/connection-manager.js";
import { isClientConnectedSomewhere, readModelCatalogRpcResult } from "../services/runtime/rpc/provider-models.js";
import { serializeDate } from "../utils.js";
import { clientCommandVersionHint } from "./client-command-version.js";

/**
 * Class C — `/api/v1/clients/:id` and member-self utilities. A client is
 * owned by exactly one user (cross-org under one user is allowed); the
 * org doesn't appear in this URL because it doesn't gate access.
 */
export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { clientId: string } }>("/:clientId", async (request) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    const client = await clientService.getClient(app.db, clientId);
    if (!client) throw new Error("unreachable: client missing after owner check");
    // Normalize through the capability schema (same as /me/clients) so a legacy
    // snapshot is coerced to the canonical install-only shape rather than served
    // raw — the chat login button polls this endpoint and must not receive a
    // legacy `unauthenticated` state the web no longer handles.
    const capabilities = clientService.capabilitiesForApi(client.metadata, client);
    const refreshExpirySeconds = expiryToSeconds(app.config.auth.refreshTokenExpiry);
    const binName = getChannelConfig(app.config.channel).binName;
    return {
      id: client.id,
      userId: client.userId,
      status: clientService.clientStatusForApi(client),
      authState: clientService.deriveAuthState(client, refreshExpirySeconds),
      binName,
      sdkVersion: client.sdkVersion,
      hostname: client.hostname,
      os: client.os,
      connectedAt: serializeDate(client.connectedAt),
      lastSeenAt: client.lastSeenAt.toISOString(),
      capabilities,
      lastUpdateAttempt: clientService.extractLastUpdateAttempt(client.metadata),
      ...clientCommandVersionHint(app, client.sdkVersion),
    };
  });

  app.patch<{ Params: { clientId: string } }>("/:clientId/capabilities", async (request, reply) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.assertClientNotRetired(app.db, clientId);
    const body = updateClientCapabilitiesSchema.parse(request.body);
    await clientService.updateClientCapabilities(app.db, clientId, body.capabilities);
    return reply.status(204).send();
  });

  // Start an in-product runtime-auth login on the connected daemon: the member
  // clicked "Connect <provider>" in the console. We forward a reverse command
  // over the client's live WS (same precedent as session suspend/resume); the
  // daemon runs the provider's official login and reflects progress by
  // re-PATCHing capabilities, which the web polls. Fire-and-forget: 503 only if
  // the daemon is not connected to this server process.
  app.post<{ Params: { clientId: string } }>("/:clientId/runtime-auth/start", async (request) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.assertClientNotRetired(app.db, clientId);
    const body = runtimeAuthStartRequestSchema.parse(request.body);
    const ref = randomUUID();
    const delivered = sendToClient(clientId, {
      type: RUNTIME_AUTH_START_TYPE,
      provider: body.provider,
      ...(body.method ? { method: body.method } : {}),
      ref,
    });
    if (!delivered) {
      throw new ServiceUnavailableError(
        "Runtime-auth could not start because this computer is not connected. Make sure the daemon is running, then retry.",
      );
    }
    return { ref, started: true as const };
  });

  // Readiness is deliberately separate from install-only capability probing.
  // The daemon uses the same host-local provider runtime and identity as real
  // work, then reports only a bounded verdict through capability metadata.
  app.post<{ Params: { id: string } }>("/:id/runtime-readiness/start", async (request) => {
    const { userId } = requireUser(request);
    const clientId = request.params.id;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.assertClientNotRetired(app.db, clientId);
    const body = runtimeReadinessStartRequestSchema.parse(request.body);
    const client = await clientService.getClient(app.db, clientId);
    if (!client || !isClientConnectedSomewhere(client) || !client.instanceId) {
      throw new ServiceUnavailableError(
        "Runtime readiness could not start because this computer is not connected. Make sure the daemon is running, then retry.",
      );
    }
    if (!clientService.metadataSupportsRuntimeReadiness(client.metadata)) {
      throw new BadRequestError(
        "Runtime readiness is unavailable because this computer's First Tree CLI does not support the readiness protocol. Upgrade this computer, then retry.",
      );
    }

    const ref = randomUUID();
    const frame = {
      type: RUNTIME_READINESS_CHECK_TYPE,
      provider: body.provider,
      ...(body.config ? { config: body.config } : {}),
      ...(body.force !== undefined ? { force: body.force } : {}),
      ref,
    };
    if (client.instanceId === app.config.instanceId) {
      if (!clientSupportsRuntimeReadinessV1(clientId)) {
        throw new BadRequestError(
          "Runtime readiness is unavailable because this computer's active First Tree CLI connection does not support the readiness protocol. Upgrade this computer, then retry.",
        );
      }
      if (!sendToClient(clientId, frame)) {
        throw new ServiceUnavailableError(
          "Runtime readiness could not start because this computer is not connected. Make sure the daemon is running, then retry.",
        );
      }
    } else {
      await app.notifier.notifyDaemonClientCommand({
        ...frame,
        clientId,
        targetInstanceId: client.instanceId,
      });
    }
    return { ref, started: true as const };
  });

  // Host-local model catalog: ask the connected daemon to discover models from
  // the real provider on that computer, wait for the correlated reply, and
  // return the catalog to the web. Delivery is scoped to the DB-authoritative
  // `clients.instance_id` (local send or PG NOTIFY fan-out). Results are stored
  // in clients.metadata; on waiter timeout we still read that durable copy so a
  // lost NOTIFY does not false-fail. Computer offline → 502; reply timeout → 504
  // (web picker maps both to silent degrade; avoid 503 which triggers retry).
  app.get<{ Params: { clientId: string; provider: string } }>(
    "/:clientId/providers/:provider/models",
    async (request) => {
      const { userId } = requireUser(request);
      const { clientId, provider: rawProvider } = request.params;
      stampClientResource(request, clientId);
      await clientService.assertClientOwner(app.db, clientId, { userId });
      await clientService.assertClientNotRetired(app.db, clientId);
      const provider = runtimeProviderSchema.parse(rawProvider);
      const client = await clientService.getClient(app.db, clientId);
      if (!client || !isClientConnectedSomewhere(client) || !client.instanceId) {
        throw new BadGatewayError(
          "Could not list models because this computer is not connected. Make sure the daemon is running, then retry.",
        );
      }
      const targetInstanceId = client.instanceId;
      const ref = randomUUID();
      const replyPromise = waitForClientReply(clientId, ref);
      const daemonFrame = {
        type: PROVIDER_MODELS_LIST_TYPE,
        provider,
        ref,
      };
      if (targetInstanceId === app.config.instanceId) {
        const delivered = sendToClient(clientId, daemonFrame);
        if (!delivered) {
          rejectPendingRepliesForClient(clientId, new Error("Computer not connected"));
          await replyPromise.catch(() => undefined);
          throw new BadGatewayError(
            "Could not list models because this computer is not connected. Make sure the daemon is running, then retry.",
          );
        }
      } else {
        await app.notifier.notifyDaemonClientCommand({
          type: PROVIDER_MODELS_LIST_TYPE,
          clientId,
          provider,
          ref,
          targetInstanceId,
        });
      }
      try {
        const raw = await replyPromise;
        return providerModelCatalogSchema.parse(raw);
      } catch (err) {
        // Race-safe fallback: catalog may already be durable while the wake was lost.
        const stored = await readModelCatalogRpcResult(app.db, clientId, ref);
        if (stored) return stored;
        const timedOut = err instanceof Error && err.message.toLowerCase().includes("timed out");
        if (timedOut) {
          throw new GatewayTimeoutError(
            err instanceof Error ? err.message : "Timed out waiting for this computer to list models.",
          );
        }
        throw new BadGatewayError(
          err instanceof Error
            ? err.message
            : "Could not list models from this computer. Retry after the daemon is connected.",
        );
      }
    },
  );

  app.post<{ Params: { clientId: string } }>("/:clientId/disconnect", async (request) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.assertClientNotRetired(app.db, clientId);
    const agentIds = forceDisconnectClient(clientId);
    await clientService.disconnectClient(app.db, clientId);
    return { disconnected: true, agentIds };
  });

  app.delete<{ Params: { clientId: string } }>("/:clientId", async (request, reply) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.retireClient(app.db, clientId);
    forceDisconnectClient(clientId);
    return reply.status(204).send();
  });

  // POST /:clientId/claim (cross-user ownership transfer) was removed: a
  // clientId is org-visible, so with only-JWT auth the route let any
  // authenticated user knock another user's machine offline. Machine handover
  // is local-only: the operator must `login <code>` as the target user so
  // the old local client is parked and a separate local client identity is
  // activated (no server-side transfer protocol to secure).
}
