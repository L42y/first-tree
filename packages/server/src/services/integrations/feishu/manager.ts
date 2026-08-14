import {
  FEISHU_REQUIRED_SCOPES,
  type FeishuBotBinding,
  type FeishuReferenceContext,
  feishuBotBindingSchema,
} from "@first-tree/shared";
import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { agents } from "../../../db/schema/agents.js";
import { clients } from "../../../db/schema/clients.js";
import { imBotBindings } from "../../../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../../../db/schema/im-chat-bindings.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../../errors.js";
import { createLogger } from "../../../observability/index.js";
import { uuidv7 } from "../../../uuid.js";
import type { AttachmentObjectQuota } from "../../attachment.js";
import { decryptCredentials, encryptCredentials } from "../../crypto.js";
import type { Notifier } from "../../notifier.js";
import { isFeishuBotUsable } from "./binding-state.js";
import { Client, createLarkChannel, type LarkChannel, LoggerLevel, registerApp } from "./channel-sdk.js";
import { readFeishuCliCapability } from "./cli-capability.js";
import { ingestFeishuMessage, logFeishuInboundFailure } from "./inbound.js";
import { readFeishuParentMessage, withFeishuAbortTimeout } from "./provider-reader.js";
import { loadFeishuReferenceContextTarget, readFeishuReferenceContext } from "./reference-context.js";
import { safeFeishuErrorContext, safeFeishuErrorMessage } from "./safe-error.js";
import { createFeishuSenderNameResolver } from "./sender-name.js";

const log = createLogger("feishu-manager");
const LEASE_MS = 45_000;
const CLAIM_INTERVAL_MS = 15_000;
const REGISTRATION_QR_TIMEOUT_MS = 20_000;
const BOT_PROFILE_TIMEOUT_MS = 5_000;
const INBOUND_PARENT_LOOKUP_TIMEOUT_MS = 3_000;
const REFERENCE_CONTEXT_TIMEOUT_MS = 5_000;
const MAX_ACKNOWLEDGEMENT_REACTIONS_IN_FLIGHT = 16;
// The SDK's generic request logger may receive transport errors that include
// Authorization headers. Callers record redacted operation context instead.
const SILENT_FEISHU_CLIENT_LOGGER = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

type BindingRow = typeof imBotBindings.$inferSelect;
type RegistrationEntry = {
  controller: AbortController;
  terminal: boolean;
  cancel(error: Error): void;
};

type RegistrationState = { url: string; expiresAt: string };
type ConnectedChannel = { channel: LarkChannel; epoch: number };

export type FeishuIntegrationManager = {
  start(): void;
  stop(): Promise<void>;
  getBinding(agentId: string): Promise<FeishuBotBinding | null>;
  startRegistration(input: { agentId: string; organizationId: string; displayName: string }): Promise<FeishuBotBinding>;
  revoke(agentId: string): Promise<void>;
  getCliGrant(agentId: string): Promise<{
    binding: BindingRow;
    appId: string;
    appSecret: string;
  }>;
  getReferenceContext(agentId: string, firstTreeMessageId: string): Promise<FeishuReferenceContext>;
};

export type FeishuSdkDependencies = {
  registerApp: typeof registerApp;
  createLarkChannel: typeof createLarkChannel;
  createClient: (options: ConstructorParameters<typeof Client>[0]) => Pick<Client, "im" | "request">;
};

type FeishuBotInfoResponse = {
  code?: number;
  msg?: string;
  bot?: {
    app_name?: string;
    avatar_url?: string;
    open_id?: string;
  };
};

export function createFeishuIntegrationManager(input: {
  db: Database;
  notifier: Notifier;
  encryptionKey: string;
  instanceId: string;
  attachmentObjectQuota: AttachmentObjectQuota;
  sdk?: FeishuSdkDependencies;
  timings?: {
    leaseMs?: number;
    claimIntervalMs?: number;
    initialClaimDelayMs?: number;
    registrationQrTimeoutMs?: number;
    botProfileTimeoutMs?: number;
  };
  testHooks?: {
    afterCredentialCommit?(bindingId: string): Promise<void>;
  };
}): FeishuIntegrationManager {
  const { db, notifier, encryptionKey, instanceId, attachmentObjectQuota } = input;
  const leaseMs = input.timings?.leaseMs ?? LEASE_MS;
  const claimIntervalMs = input.timings?.claimIntervalMs ?? CLAIM_INTERVAL_MS;
  const initialClaimDelayMs = input.timings?.initialClaimDelayMs ?? 2_000;
  const registrationQrTimeoutMs = input.timings?.registrationQrTimeoutMs ?? REGISTRATION_QR_TIMEOUT_MS;
  const botProfileTimeoutMs = input.timings?.botProfileTimeoutMs ?? BOT_PROFILE_TIMEOUT_MS;
  const sdk: FeishuSdkDependencies = input.sdk ?? {
    registerApp,
    createLarkChannel,
    createClient: (options) => new Client(options),
  };
  const channels = new Map<string, ConnectedChannel>();
  const registrations = new Map<string, RegistrationEntry>();
  const senderNames = createFeishuSenderNameResolver();
  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function getBindingRow(agentId: string): Promise<BindingRow | null> {
    const [row] = await db
      .select()
      .from(imBotBindings)
      .where(and(eq(imBotBindings.agentId, agentId), sql`${imBotBindings.status} <> 'revoked'`))
      .limit(1);
    return row ?? null;
  }

  async function getBinding(agentId: string): Promise<FeishuBotBinding | null> {
    const row = await getBindingRow(agentId);
    if (!row) return null;
    const [agent] = await db
      .select({ clientId: agents.clientId, clientMetadata: clients.metadata })
      .from(agents)
      .leftJoin(clients, eq(clients.id, agents.clientId))
      .where(eq(agents.uuid, agentId))
      .limit(1);
    const capability = readFeishuCliCapability(agent?.clientMetadata);
    const registration = decryptRegistration(row.registrationStateCipher);
    return feishuBotBindingSchema.parse({
      id: row.id,
      agentId: row.agentId,
      appId: row.appId,
      botOpenId: row.botOpenId,
      botName: row.botName,
      botAvatarUrl: row.botAvatarUrl,
      tenantKey: row.tenantKey,
      status: row.status,
      connectionStatus: row.connectionStatus,
      grantedScopes: row.grantedScopes,
      registrationUrl: registration?.url ?? null,
      registrationExpiresAt: row.registrationExpiresAt?.toISOString() ?? null,
      lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: row.lastErrorMessage,
      cli: {
        state: !agent?.clientId ? "offline" : capability?.available ? "ready" : capability ? "missing" : "unknown",
        version: capability?.sdkVersion ?? null,
        clientId: agent?.clientId ?? null,
      },
    });
  }

  async function startRegistration(registration: {
    agentId: string;
    organizationId: string;
    displayName: string;
  }): Promise<FeishuBotBinding> {
    const [agent] = await db
      .select({
        organizationId: agents.organizationId,
        status: agents.status,
        type: agents.type,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(eq(agents.uuid, registration.agentId))
      .limit(1);
    if (
      !agent ||
      agent.organizationId !== registration.organizationId ||
      agent.status !== "active" ||
      agent.type !== "agent"
    ) {
      throw new NotFoundError("An active worker Agent in this organization is required for Feishu binding");
    }
    if (agent.visibility !== "organization") {
      throw new BadRequestError("Feishu Bot binding requires an organization-visible Agent");
    }
    let existing = await getBindingRow(registration.agentId);
    if (existing?.status === "error") {
      await revoke(registration.agentId);
      existing = null;
    } else if (existing?.status === "provisioning") {
      throw new ConflictError("This Agent already has a Feishu registration in progress");
    }
    const restoresExistingBinding = existing?.status === "active";
    const previousAppId = existing?.status === "active" ? existing.appId : null;
    const previousBotOpenId = existing?.status === "active" ? existing.botOpenId : null;
    const id = existing?.id ?? uuidv7();
    if (registrations.has(id)) throw new ConflictError("This Agent already has a Feishu registration in progress");
    const controller = new AbortController();
    const startingStateCipher = encryptCredentials({ phase: "starting" }, encryptionKey);
    let attemptStateCipher = startingStateCipher;
    let qrStateWrite: Promise<void> | null = null;
    const startingExpiresAt = new Date(Date.now() + registrationQrTimeoutMs);
    if (restoresExistingBinding) {
      const [updated] = await db
        .update(imBotBindings)
        .set({
          status: "provisioning",
          registrationStateCipher: startingStateCipher,
          registrationExpiresAt: startingExpiresAt,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(imBotBindings.id, id),
            eq(imBotBindings.status, "active"),
            isNull(imBotBindings.registrationStateCipher),
          ),
        )
        .returning({ id: imBotBindings.id });
      if (!updated) throw new ConflictError("This Agent's Feishu Bot binding changed; retry the update");
    } else {
      await db.insert(imBotBindings).values({
        id,
        organizationId: registration.organizationId,
        agentId: registration.agentId,
        registrationStateCipher: startingStateCipher,
        registrationExpiresAt: startingExpiresAt,
      });
    }

    let resolveQr!: () => void;
    let rejectQr!: (error: unknown) => void;
    const qrReady = new Promise<void>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });
    const registrationEntry: RegistrationEntry = {
      controller,
      terminal: false,
      cancel: (error) => {
        if (registrationEntry.terminal) return;
        registrationEntry.terminal = true;
        controller.abort();
        rejectQr(error);
      },
    };
    registrations.set(id, registrationEntry);
    // A provider can complete registration immediately after emitting the QR
    // callback. Hold that transition until the initiating request has read the
    // persisted QR state, otherwise the fast completion can clear the URL
    // before the registration response is serialized.
    let releaseQrResponse!: () => void;
    const qrResponseRead = new Promise<void>((resolve) => {
      releaseQrResponse = resolve;
    });
    const qrTimeout = setTimeout(() => {
      const error = new Error("Timed out waiting for Feishu registration QR code");
      // Local request completion must not depend on the row transition. A
      // concurrent revoke can legitimately make the conditional UPDATE a
      // no-op while the provider ignores AbortSignal forever.
      registrationEntry.cancel(error);
      void transitionCurrentAttemptToError(error)
        .catch(() => undefined)
        .finally(() => {
          if (registrations.get(id) === registrationEntry) registrations.delete(id);
        });
    }, registrationQrTimeoutMs);

    void sdk
      .registerApp({
        source: "first-tree",
        signal: controller.signal,
        createOnly: false,
        appPreset: {
          name: registration.displayName,
          desc: "由 First Tree Agent 提供服务",
        },
        addons: {
          preset: true,
          scopes: { tenant: [...FEISHU_REQUIRED_SCOPES] },
          events: { items: { tenant: ["im.message.receive_v1"] } },
        },
        onQRCodeReady: ({ url, expireIn }) => {
          if (registrationEntry.terminal) {
            rejectQr(new Error("Feishu registration is no longer active"));
            return;
          }
          const expiresAt = new Date(Date.now() + expireIn * 1000);
          const qrCipher = encryptCredentials({ url, expiresAt: expiresAt.toISOString() }, encryptionKey);
          qrStateWrite = db
            .update(imBotBindings)
            .set({
              registrationStateCipher: qrCipher,
              registrationExpiresAt: expiresAt,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(imBotBindings.id, id),
                eq(imBotBindings.status, "provisioning"),
                previousAppId ? eq(imBotBindings.appId, previousAppId) : isNull(imBotBindings.appId),
                eq(imBotBindings.registrationExpiresAt, startingExpiresAt),
                eq(imBotBindings.registrationStateCipher, startingStateCipher),
              ),
            )
            .returning({ id: imBotBindings.id })
            .then((updated) => {
              if (updated.length === 0) throw new Error("Feishu registration is no longer active");
              attemptStateCipher = qrCipher;
              resolveQr();
            })
            .catch((error) => {
              rejectQr(error);
            });
        },
      })
      .then(async (result) => {
        // The confirmation can complete immediately after the QR callback.
        // Serialize the credential transition behind the QR-state write so a
        // late callback update cannot restore stale registration metadata.
        await qrReady;
        await qrResponseRead;
        const candidateClient = sdk.createClient({
          appId: result.client_id,
          appSecret: result.client_secret,
          loggerLevel: LoggerLevel.warn,
          logger: SILENT_FEISHU_CLIENT_LOGGER,
        });
        const validatedBot = await getBotIdentity(candidateClient, botProfileTimeoutMs);
        if (
          previousAppId === result.client_id &&
          previousBotOpenId !== null &&
          validatedBot.botOpenId !== previousBotOpenId
        ) {
          throw new Error("Feishu Bot identity changed while reauthorizing the existing App");
        }
        const cipher = encryptCredentials({ appSecret: result.client_secret }, encryptionKey);
        const replacesBot = previousAppId !== null && previousAppId !== result.client_id;
        const nextBindingId = replacesBot ? uuidv7() : id;
        const updatedBindingId = await db.transaction(async (tx) => {
          const now = new Date();
          if (replacesBot) {
            const [revoked] = await tx
              .update(imBotBindings)
              .set({
                status: "revoked",
                appSecretCipher: null,
                registrationStateCipher: null,
                registrationExpiresAt: null,
                connectionStatus: "disconnected",
                connectionOwnerInstanceId: null,
                connectionLeaseExpiresAt: null,
                connectionEpoch: sql`${imBotBindings.connectionEpoch} + 1`,
                revokedAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(imBotBindings.id, id),
                  eq(imBotBindings.status, "provisioning"),
                  eq(imBotBindings.appId, previousAppId),
                  isNotNull(imBotBindings.registrationExpiresAt),
                  gt(imBotBindings.registrationExpiresAt, now),
                  eq(imBotBindings.registrationStateCipher, attemptStateCipher),
                ),
              )
              .returning({ id: imBotBindings.id });
            if (!revoked) return null;
            await tx
              .update(imChatBindings)
              .set({ status: "detached", updatedAt: now })
              .where(and(eq(imChatBindings.botBindingId, id), eq(imChatBindings.status, "active")));
            const [replacement] = await tx
              .insert(imBotBindings)
              .values({
                id: nextBindingId,
                organizationId: registration.organizationId,
                agentId: registration.agentId,
                appId: result.client_id,
                appSecretCipher: cipher,
                botOpenId: validatedBot.botOpenId,
                botName: validatedBot.botName,
                botAvatarUrl: validatedBot.botAvatarUrl,
                grantedScopes: [...FEISHU_REQUIRED_SCOPES],
                status: "provisioning",
              })
              .returning({ id: imBotBindings.id });
            return replacement?.id ?? null;
          }
          const [row] = await tx
            .update(imBotBindings)
            .set({
              appId: result.client_id,
              appSecretCipher: cipher,
              botOpenId: validatedBot.botOpenId,
              botName: validatedBot.botName,
              botAvatarUrl: validatedBot.botAvatarUrl,
              registrationStateCipher: null,
              registrationExpiresAt: null,
              grantedScopes: [...FEISHU_REQUIRED_SCOPES],
              status: "provisioning",
              connectionStatus: "disconnected",
              connectionOwnerInstanceId: null,
              connectionLeaseExpiresAt: null,
              connectionEpoch: sql`${imBotBindings.connectionEpoch} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(imBotBindings.id, id),
                eq(imBotBindings.status, "provisioning"),
                previousAppId ? eq(imBotBindings.appId, previousAppId) : isNull(imBotBindings.appId),
                isNotNull(imBotBindings.registrationExpiresAt),
                gt(imBotBindings.registrationExpiresAt, now),
                eq(imBotBindings.registrationStateCipher, attemptStateCipher),
              ),
            )
            .returning({ id: imBotBindings.id });
          return row?.id ?? null;
        });
        if (!updatedBindingId) return;
        await input.testHooks?.afterCredentialCommit?.(updatedBindingId);
        if (replacesBot) await disconnectLocalChannel(id);
        await connectNewBinding(updatedBindingId);
      })
      .catch(async (error) => {
        await transitionCurrentAttemptToError(error);
        rejectQr(error);
      })
      .finally(() => {
        if (registrations.get(id) === registrationEntry) registrations.delete(id);
      });

    try {
      await qrReady;
      const view = await getBinding(registration.agentId);
      if (!view) throw new Error("Feishu registration row disappeared");
      return view;
    } finally {
      clearTimeout(qrTimeout);
      releaseQrResponse();
    }

    async function transitionCurrentAttemptToError(error: unknown): Promise<boolean> {
      await qrStateWrite?.catch(() => undefined);
      return transitionRegistrationToError(id, error, restoresExistingBinding, attemptStateCipher);
    }
  }

  async function transitionRegistrationToError(
    id: string,
    error: unknown,
    restoresExistingBinding: boolean,
    attemptStateCipher: string,
  ): Promise<boolean> {
    const updated = await db
      .update(imBotBindings)
      .set({
        status: restoresExistingBinding ? "active" : "error",
        registrationStateCipher: null,
        registrationExpiresAt: null,
        ...(!restoresExistingBinding ? { connectionStatus: "error" as const } : {}),
        lastErrorCode: safeFeishuErrorContext(error).errorCode,
        lastErrorMessage: safeFeishuErrorMessage(error),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imBotBindings.id, id),
          eq(imBotBindings.status, "provisioning"),
          restoresExistingBinding ? isNotNull(imBotBindings.appId) : isNull(imBotBindings.appId),
          eq(imBotBindings.registrationStateCipher, attemptStateCipher),
        ),
      )
      .returning({ id: imBotBindings.id });
    return updated.length > 0;
  }

  async function connectNewBinding(id: string): Promise<void> {
    const leaseUntil = new Date(Date.now() + leaseMs);
    const [claimed] = await db
      .update(imBotBindings)
      .set({
        connectionOwnerInstanceId: instanceId,
        connectionLeaseExpiresAt: leaseUntil,
        connectionEpoch: sql`${imBotBindings.connectionEpoch} + 1`,
        connectionStatus: "connecting",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imBotBindings.id, id),
          eq(imBotBindings.status, "provisioning"),
          isNotNull(imBotBindings.appId),
          isNotNull(imBotBindings.appSecretCipher),
        ),
      )
      .returning();
    if (!claimed) return;
    await disconnectLocalChannel(id);
    await connectClaimed(claimed);
  }

  async function disconnectLocalChannel(id: string): Promise<void> {
    const previous = channels.get(id);
    if (!previous) return;
    channels.delete(id);
    senderNames.clearBinding(id);
    await previous.channel.disconnect().catch(() => undefined);
  }

  async function claimAndMaintain(): Promise<void> {
    if (stopped) return;
    const now = new Date();
    await recoverExpiredRegistrations(now);
    const leaseUntil = new Date(Date.now() + leaseMs);
    const channelIds = [...channels.keys()];
    if (channelIds.length > 0) {
      for (const id of channelIds) {
        const connected = channels.get(id);
        if (!connected) continue;
        const renewed = await db
          .update(imBotBindings)
          .set({ connectionLeaseExpiresAt: leaseUntil, updatedAt: now })
          .where(
            and(
              eq(imBotBindings.id, id),
              eq(imBotBindings.connectionOwnerInstanceId, instanceId),
              eq(imBotBindings.connectionEpoch, connected.epoch),
              inArray(imBotBindings.status, ["active", "provisioning"]),
            ),
          )
          .returning({ id: imBotBindings.id });
        if (renewed.length > 0) continue;
        channels.delete(id);
        await connected.channel.disconnect().catch(() => undefined);
      }
    }

    const candidates = await db
      .select({ id: imBotBindings.id })
      .from(imBotBindings)
      .where(
        and(
          inArray(imBotBindings.status, ["active", "provisioning"]),
          sql`${imBotBindings.appSecretCipher} IS NOT NULL`,
          or(isNull(imBotBindings.connectionLeaseExpiresAt), lt(imBotBindings.connectionLeaseExpiresAt, now)),
        ),
      )
      .limit(20);

    for (const candidate of candidates) {
      const [claimed] = await db
        .update(imBotBindings)
        .set({
          connectionOwnerInstanceId: instanceId,
          connectionLeaseExpiresAt: leaseUntil,
          connectionEpoch: sql`${imBotBindings.connectionEpoch} + 1`,
          connectionStatus: "connecting",
          updatedAt: now,
        })
        .where(
          and(
            eq(imBotBindings.id, candidate.id),
            or(isNull(imBotBindings.connectionLeaseExpiresAt), lt(imBotBindings.connectionLeaseExpiresAt, now)),
          ),
        )
        .returning();
      if (claimed && !channels.has(claimed.id)) {
        await connectClaimed(claimed).catch((error) =>
          log.warn({ bindingId: claimed.id, ...safeFeishuErrorContext(error) }, "Feishu connection failed"),
        );
      }
    }
  }

  async function recoverExpiredRegistrations(now: Date): Promise<void> {
    const restored = await db
      .update(imBotBindings)
      .set({
        status: "active",
        registrationStateCipher: null,
        registrationExpiresAt: null,
        lastErrorCode: "registration_expired",
        lastErrorMessage: "Feishu authorization expired; the existing Bot remains connected",
        updatedAt: now,
      })
      .where(
        and(
          eq(imBotBindings.status, "provisioning"),
          isNotNull(imBotBindings.appId),
          isNotNull(imBotBindings.appSecretCipher),
          isNotNull(imBotBindings.botOpenId),
          isNotNull(imBotBindings.registrationStateCipher),
          isNotNull(imBotBindings.registrationExpiresAt),
          lt(imBotBindings.registrationExpiresAt, now),
        ),
      )
      .returning({ id: imBotBindings.id });
    const failed = await db
      .update(imBotBindings)
      .set({
        status: "error",
        connectionStatus: "error",
        registrationStateCipher: null,
        registrationExpiresAt: null,
        lastErrorCode: "registration_expired",
        lastErrorMessage: "Feishu authorization expired",
        updatedAt: now,
      })
      .where(
        and(
          eq(imBotBindings.status, "provisioning"),
          isNull(imBotBindings.appId),
          isNotNull(imBotBindings.registrationStateCipher),
          isNotNull(imBotBindings.registrationExpiresAt),
          lt(imBotBindings.registrationExpiresAt, now),
        ),
      )
      .returning({ id: imBotBindings.id });
    for (const { id } of [...restored, ...failed]) {
      const registration = registrations.get(id);
      registration?.cancel(new Error("Feishu authorization expired"));
      if (registrations.get(id) === registration) registrations.delete(id);
    }
  }

  async function connectClaimed(row: BindingRow): Promise<void> {
    if (!row.appId || !row.appSecretCipher) throw new Error("Feishu binding has no credentials");
    const { appSecret } = decryptSecret(row.appSecretCipher);
    const client = sdk.createClient({
      appId: row.appId,
      appSecret,
      loggerLevel: LoggerLevel.warn,
      logger: SILENT_FEISHU_CLIENT_LOGGER,
    });
    const channel = sdk.createLarkChannel({
      appId: row.appId,
      appSecret,
      includeRawEvent: true,
      loggerLevel: LoggerLevel.warn,
      logger: SILENT_FEISHU_CLIENT_LOGGER,
      source: "first-tree",
      policy: { requireMention: false, dmMode: "open", respondToMentionAll: false },
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 10 },
    });
    let acknowledgementReactionsInFlight = 0;
    async function addAcknowledgementReaction(input: { messageId: string; emojiType: string }): Promise<string | null> {
      // The SDK has no default HTTP timeout. Keep permanently stalled
      // provider calls bounded per owned Channel and drop excess best-effort
      // acknowledgements instead of letting them consume unbounded resources.
      if (acknowledgementReactionsInFlight >= MAX_ACKNOWLEDGEMENT_REACTIONS_IN_FLIGHT) return null;
      acknowledgementReactionsInFlight += 1;
      try {
        return await channel.addReaction(input.messageId, input.emojiType);
      } finally {
        acknowledgementReactionsInFlight -= 1;
      }
    }
    channel.on("message", async (message) => {
      try {
        const current = await requireOwnedBinding(row.id, row.connectionEpoch);
        const result = await ingestFeishuMessage(db, notifier, current, message, {
          senderNames,
          attachmentObjectQuota,
          addReaction: addAcknowledgementReaction,
          readParentMessage: (messageId) =>
            readFeishuParentMessage(client, messageId, INBOUND_PARENT_LOOKUP_TIMEOUT_MS),
          readMembers: async ({ chatId, idType, pageToken }) =>
            client.im.v1.chatMembers.get({
              path: { chat_id: chatId },
              params: { member_id_type: idType, page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
            }),
          downloadResource: async ({ messageId, fileKey, type }) => {
            const response = await client.im.v1.messageResource.get({
              path: { message_id: messageId, file_key: fileKey },
              params: { type },
            });
            return { stream: response.getReadableStream(), headers: response.headers as Record<string, unknown> };
          },
        });
        if (result.state === "ignored") return;
        await db
          .update(imBotBindings)
          .set({ lastEventAt: new Date(), tenantKey: tenantKeyFromRaw(message.raw) ?? current.tenantKey })
          .where(
            and(
              eq(imBotBindings.id, row.id),
              eq(imBotBindings.connectionOwnerInstanceId, instanceId),
              eq(imBotBindings.connectionEpoch, row.connectionEpoch),
            ),
          );
      } catch (error) {
        logFeishuInboundFailure(row.id, error);
      }
    });
    channel.on("reconnecting", () => {
      void setConnectionState(row.id, row.connectionEpoch, "connecting");
    });
    channel.on("reconnected", () => {
      void setConnectionState(row.id, row.connectionEpoch, "connected");
    });
    channel.on("error", (error) => {
      void setConnectionError(row.id, row.connectionEpoch, error);
    });
    channels.set(row.id, { channel, epoch: row.connectionEpoch });
    try {
      await channel.connect();
      const botOpenId = channel.botIdentity?.openId;
      if (!botOpenId) throw new Error("Feishu Channel connected without Bot identity");
      if (row.botOpenId && row.botOpenId !== botOpenId) {
        throw new Error("Feishu Channel Bot identity did not match the validated credential identity");
      }
      const [activated] = await db
        .update(imBotBindings)
        .set({
          botOpenId,
          status: sql`CASE WHEN ${imBotBindings.registrationStateCipher} IS NULL THEN 'active' ELSE 'provisioning' END`,
          connectionStatus: "connected",
          lastConnectedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(imBotBindings.id, row.id),
            eq(imBotBindings.connectionOwnerInstanceId, instanceId),
            eq(imBotBindings.connectionEpoch, row.connectionEpoch),
          ),
        )
        .returning({ id: imBotBindings.id });
      if (!activated) throw new Error("Feishu connection ownership changed before activation");

      try {
        const botProfile = await getBotProfile(client, botOpenId, botProfileTimeoutMs);
        await db
          .update(imBotBindings)
          .set({ ...botProfile, updatedAt: new Date() })
          .where(
            and(
              eq(imBotBindings.id, row.id),
              eq(imBotBindings.connectionOwnerInstanceId, instanceId),
              eq(imBotBindings.connectionEpoch, row.connectionEpoch),
              inArray(imBotBindings.status, ["active", "provisioning"]),
              eq(imBotBindings.botOpenId, botOpenId),
            ),
          );
      } catch (error) {
        log.warn({ bindingId: row.id, ...safeFeishuErrorContext(error) }, "Failed to load Feishu Bot profile");
      }
    } catch (error) {
      channels.delete(row.id);
      await channel.disconnect().catch(() => undefined);
      await setConnectionError(row.id, row.connectionEpoch, error);
      throw error;
    }
  }

  async function requireOwnedBinding(id: string, epoch: number): Promise<BindingRow> {
    const [row] = await db
      .select()
      .from(imBotBindings)
      .where(
        and(
          eq(imBotBindings.id, id),
          eq(imBotBindings.connectionOwnerInstanceId, instanceId),
          eq(imBotBindings.connectionEpoch, epoch),
          sql`${imBotBindings.connectionLeaseExpiresAt} > now()`,
        ),
      )
      .limit(1);
    if (!row) throw new Error("Feishu connection lease is no longer owned by this server");
    return row;
  }

  async function setConnectionState(id: string, epoch: number, state: "connecting" | "connected") {
    await db
      .update(imBotBindings)
      .set({ connectionStatus: state, updatedAt: new Date() })
      .where(
        and(
          eq(imBotBindings.id, id),
          eq(imBotBindings.connectionOwnerInstanceId, instanceId),
          eq(imBotBindings.connectionEpoch, epoch),
        ),
      );
  }

  async function setConnectionError(id: string, epoch: number, error: unknown) {
    await db
      .update(imBotBindings)
      .set({
        connectionStatus: "error",
        lastErrorCode: safeFeishuErrorContext(error).errorCode,
        lastErrorMessage: safeFeishuErrorMessage(error),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imBotBindings.id, id),
          eq(imBotBindings.connectionOwnerInstanceId, instanceId),
          eq(imBotBindings.connectionEpoch, epoch),
        ),
      );
  }

  async function revoke(agentId: string): Promise<void> {
    const row = await getBindingRow(agentId);
    if (!row) throw new NotFoundError("Feishu Bot binding not found");
    registrations.get(row.id)?.cancel(new Error("Feishu registration was revoked"));
    registrations.delete(row.id);
    senderNames.clearBinding(row.id);
    const connected = channels.get(row.id);
    channels.delete(row.id);
    await connected?.channel.disconnect().catch(() => undefined);
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(imBotBindings)
        .set({
          status: "revoked",
          appSecretCipher: null,
          registrationStateCipher: null,
          registrationExpiresAt: null,
          connectionStatus: "disconnected",
          connectionOwnerInstanceId: null,
          connectionLeaseExpiresAt: null,
          revokedAt: now,
          updatedAt: now,
        })
        .where(eq(imBotBindings.id, row.id));
      await tx
        .update(imChatBindings)
        .set({ status: "detached", updatedAt: now })
        .where(and(eq(imChatBindings.botBindingId, row.id), eq(imChatBindings.status, "active")));
    });
  }

  async function getCliGrant(agentId: string) {
    const binding = await getBindingRow(agentId);
    if (!binding || !isFeishuBotUsable(binding)) {
      throw new NotFoundError("Active Feishu Bot binding not found");
    }
    const { appSecret } = decryptSecret(binding.appSecretCipher);
    return {
      binding,
      appId: binding.appId,
      appSecret,
    };
  }

  async function getReferenceContext(agentId: string, firstTreeMessageId: string): Promise<FeishuReferenceContext> {
    const target = await loadFeishuReferenceContextTarget(db, agentId, firstTreeMessageId);
    if (!target.binding.appId || !target.binding.appSecretCipher) {
      throw new NotFoundError("Active Feishu Bot binding not found");
    }
    const { appSecret } = decryptSecret(target.binding.appSecretCipher);
    const client = sdk.createClient({
      appId: target.binding.appId,
      appSecret,
      loggerLevel: LoggerLevel.warn,
      logger: SILENT_FEISHU_CLIENT_LOGGER,
    });
    try {
      return await withFeishuAbortTimeout(
        (signal) => readFeishuReferenceContext(client, target, signal),
        REFERENCE_CONTEXT_TIMEOUT_MS,
        "Timed out loading Feishu reference context",
      );
    } catch (error) {
      const safe = safeFeishuErrorContext(error);
      log.warn(
        { bindingId: target.binding.id, firstTreeMessageId, ...safe },
        "Failed to load Feishu reference context",
      );
      const permissionDenied =
        ["99991672", "99991679", "403"].includes(safe.errorCode ?? "") ||
        /permission|scope|forbidden/i.test(safe.errorMessage);
      return {
        state: "unavailable",
        scope: target.scope,
        messages: [],
        truncated: false,
        reason: permissionDenied ? "permission_denied" : "provider_unavailable",
      };
    }
  }

  function decryptSecret(cipher: string): { appSecret: string } {
    const value = decryptCredentials(cipher, encryptionKey);
    if (!value || typeof value !== "object" || typeof (value as { appSecret?: unknown }).appSecret !== "string") {
      throw new Error("Invalid encrypted Feishu credential payload");
    }
    return value as { appSecret: string };
  }

  function decryptRegistration(cipher: string | null): RegistrationState | null {
    if (!cipher) return null;
    try {
      const value = decryptCredentials(cipher, encryptionKey);
      if (
        value &&
        typeof value === "object" &&
        typeof (value as RegistrationState).url === "string" &&
        typeof (value as RegistrationState).expiresAt === "string"
      ) {
        return value as RegistrationState;
      }
    } catch {
      // A stale/invalid registration is surfaced through the binding status.
    }
    return null;
  }

  return {
    start() {
      stopped = false;
      initialTimer = setTimeout(
        () =>
          void claimAndMaintain().catch((error) =>
            log.error({ ...safeFeishuErrorContext(error) }, "initial Feishu claim failed"),
          ),
        initialClaimDelayMs,
      );
      timer = setInterval(
        () =>
          void claimAndMaintain().catch((error) =>
            log.error({ ...safeFeishuErrorContext(error) }, "Feishu lease maintenance failed"),
          ),
        claimIntervalMs,
      );
    },
    async stop() {
      stopped = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (timer) clearInterval(timer);
      for (const registration of registrations.values()) {
        registration.cancel(new Error("Feishu integration manager stopped"));
      }
      registrations.clear();
      await Promise.allSettled([...channels.values()].map(({ channel }) => channel.disconnect()));
      channels.clear();
      await db
        .update(imBotBindings)
        .set({
          connectionStatus: "disconnected",
          connectionOwnerInstanceId: null,
          connectionLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(imBotBindings.connectionOwnerInstanceId, instanceId));
    },
    getBinding,
    startRegistration,
    revoke,
    getCliGrant,
    getReferenceContext,
  };
}

async function getBotProfile(
  client: Pick<Client, "request">,
  expectedOpenId: string,
  timeoutMs: number,
): Promise<{ botName: string | null; botAvatarUrl: string | null }> {
  const identity = await getBotIdentity(client, timeoutMs);
  if (identity.botOpenId !== expectedOpenId) {
    throw new Error("Feishu Bot info did not match the connected Bot identity");
  }
  return { botName: identity.botName, botAvatarUrl: identity.botAvatarUrl };
}

async function getBotIdentity(
  client: Pick<Client, "request">,
  timeoutMs: number,
): Promise<{ botOpenId: string; botName: string | null; botAvatarUrl: string | null }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      client.request<FeishuBotInfoResponse>({
        method: "GET",
        url: "/open-apis/bot/v3/info",
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Timed out loading Feishu Bot profile"));
        }, timeoutMs);
      }),
    ]);
    if (response.code !== 0 || !response.bot) {
      throw new Error(`Feishu Bot info failed: ${response.msg ?? `code ${response.code ?? "unknown"}`}`);
    }
    if (!response.bot.open_id) throw new Error("Feishu Bot info did not include a Bot identity");
    const botName = response.bot.app_name?.trim() || null;
    const botAvatarUrl = normalizeHttpUrl(response.bot.avatar_url);
    return { botOpenId: response.bot.open_id, botName, botAvatarUrl };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeHttpUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function tenantKeyFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  const event = root.event && typeof root.event === "object" ? (root.event as Record<string, unknown>) : root;
  const sender = event.sender && typeof event.sender === "object" ? (event.sender as Record<string, unknown>) : null;
  return typeof sender?.tenant_key === "string" ? sender.tenant_key : null;
}
