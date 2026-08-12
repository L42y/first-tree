import { FEISHU_REQUIRED_SCOPES, type FeishuBotBinding, feishuBotBindingSchema } from "@first-tree/shared";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { agents } from "../../../db/schema/agents.js";
import { clients } from "../../../db/schema/clients.js";
import { imBotBindings } from "../../../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../../../db/schema/im-chat-bindings.js";
import { ConflictError, NotFoundError } from "../../../errors.js";
import { createLogger } from "../../../observability/index.js";
import { uuidv7 } from "../../../uuid.js";
import { decryptCredentials, encryptCredentials } from "../../crypto.js";
import type { Notifier } from "../../notifier.js";
import { Client, createLarkChannel, type LarkChannel, LoggerLevel, registerApp } from "./channel-sdk.js";
import { ingestFeishuMessage, logFeishuInboundFailure } from "./inbound.js";
import { createFeishuSenderNameResolver } from "./sender-name.js";

const log = createLogger("feishu-manager");
const LEASE_MS = 45_000;
const CLAIM_INTERVAL_MS = 15_000;
const REGISTRATION_QR_TIMEOUT_MS = 20_000;

type BindingRow = typeof imBotBindings.$inferSelect;

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
};

export type FeishuSdkDependencies = {
  registerApp: typeof registerApp;
  createLarkChannel: typeof createLarkChannel;
  createClient: (options: ConstructorParameters<typeof Client>[0]) => Pick<Client, "im">;
};

export function createFeishuIntegrationManager(input: {
  db: Database;
  notifier: Notifier;
  encryptionKey: string;
  instanceId: string;
  sdk?: FeishuSdkDependencies;
  timings?: {
    leaseMs?: number;
    claimIntervalMs?: number;
    initialClaimDelayMs?: number;
    registrationQrTimeoutMs?: number;
  };
}): FeishuIntegrationManager {
  const { db, notifier, encryptionKey, instanceId } = input;
  const leaseMs = input.timings?.leaseMs ?? LEASE_MS;
  const claimIntervalMs = input.timings?.claimIntervalMs ?? CLAIM_INTERVAL_MS;
  const initialClaimDelayMs = input.timings?.initialClaimDelayMs ?? 2_000;
  const registrationQrTimeoutMs = input.timings?.registrationQrTimeoutMs ?? REGISTRATION_QR_TIMEOUT_MS;
  const sdk: FeishuSdkDependencies = input.sdk ?? {
    registerApp,
    createLarkChannel,
    createClient: (options) => new Client(options),
  };
  const channels = new Map<string, ConnectedChannel>();
  const registrations = new Map<string, { controller: AbortController; cancel: (error: Error) => void }>();
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
    const capability = readCliCapability(agent?.clientMetadata);
    const registration = decryptRegistration(row.registrationStateCipher);
    return feishuBotBindingSchema.parse({
      id: row.id,
      agentId: row.agentId,
      appId: row.appId,
      botOpenId: row.botOpenId,
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
      .select({ organizationId: agents.organizationId, status: agents.status, type: agents.type })
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
    const existing = await getBindingRow(registration.agentId);
    if (existing) {
      if (existing.status === "error") await revoke(registration.agentId);
      else throw new ConflictError("This Agent already has a current Feishu Bot binding");
    }
    const id = uuidv7();
    const controller = new AbortController();
    await db.insert(imBotBindings).values({
      id,
      organizationId: registration.organizationId,
      agentId: registration.agentId,
      registrationStateCipher: encryptCredentials({ phase: "starting" }, encryptionKey),
    });

    let resolveQr!: () => void;
    let rejectQr!: (error: unknown) => void;
    const qrReady = new Promise<void>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });
    registrations.set(id, {
      controller,
      cancel: (error) => {
        controller.abort();
        rejectQr(error);
      },
    });
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
      controller.abort();
      // Local request completion must not depend on the row transition. A
      // concurrent revoke can legitimately make the conditional UPDATE a
      // no-op while the provider ignores AbortSignal forever.
      rejectQr(error);
      void transitionRegistrationToError(id, error, true).catch(() => undefined);
    }, registrationQrTimeoutMs);

    void sdk
      .registerApp({
        source: "first-tree",
        signal: controller.signal,
        createOnly: true,
        appPreset: {
          name: registration.displayName,
          desc: "由 First Tree Agent 提供服务",
        },
        addons: {
          preset: false,
          scopes: { tenant: [...FEISHU_REQUIRED_SCOPES] },
          events: { items: { tenant: ["im.message.receive_v1"] } },
        },
        onQRCodeReady: ({ url, expireIn }) => {
          const expiresAt = new Date(Date.now() + expireIn * 1000);
          void db
            .update(imBotBindings)
            .set({
              registrationStateCipher: encryptCredentials({ url, expiresAt: expiresAt.toISOString() }, encryptionKey),
              registrationExpiresAt: expiresAt,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(imBotBindings.id, id),
                eq(imBotBindings.status, "provisioning"),
                isNull(imBotBindings.appId),
                isNull(imBotBindings.registrationExpiresAt),
                isNotNull(imBotBindings.registrationStateCipher),
              ),
            )
            .returning({ id: imBotBindings.id })
            .then((updated) => {
              if (updated.length === 0) throw new Error("Feishu registration is no longer active");
              resolveQr();
            }, rejectQr);
        },
      })
      .then(async (result) => {
        // The confirmation can complete immediately after the QR callback.
        // Serialize the credential transition behind the QR-state write so a
        // late callback update cannot restore stale registration metadata.
        await qrReady;
        await qrResponseRead;
        const cipher = encryptCredentials({ appSecret: result.client_secret }, encryptionKey);
        const [updated] = await db
          .update(imBotBindings)
          .set({
            appId: result.client_id,
            appSecretCipher: cipher,
            registrationStateCipher: null,
            registrationExpiresAt: null,
            grantedScopes: [...FEISHU_REQUIRED_SCOPES],
            status: "provisioning",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(imBotBindings.id, id),
              eq(imBotBindings.status, "provisioning"),
              isNull(imBotBindings.appId),
              isNotNull(imBotBindings.registrationExpiresAt),
              isNotNull(imBotBindings.registrationStateCipher),
            ),
          )
          .returning({ id: imBotBindings.id });
        if (!updated) return;
        await connectNewBinding(id);
      })
      .catch(async (error) => {
        await transitionRegistrationToError(id, error, false);
        rejectQr(error);
      })
      .finally(() => {
        registrations.delete(id);
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
  }

  async function transitionRegistrationToError(id: string, error: unknown, requireNoQr: boolean): Promise<boolean> {
    const updated = await db
      .update(imBotBindings)
      .set({
        status: "error",
        connectionStatus: "error",
        lastErrorCode: readErrorCode(error),
        lastErrorMessage: safeErrorMessage(error),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imBotBindings.id, id),
          eq(imBotBindings.status, "provisioning"),
          isNull(imBotBindings.appId),
          isNotNull(imBotBindings.registrationStateCipher),
          ...(requireNoQr ? [isNull(imBotBindings.registrationExpiresAt)] : []),
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
    if (claimed) await connectClaimed(claimed);
  }

  async function claimAndMaintain(): Promise<void> {
    if (stopped) return;
    const now = new Date();
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
              eq(imBotBindings.status, "active"),
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
          log.warn({ bindingId: claimed.id, err: error }, "Feishu connection failed"),
        );
      }
    }
  }

  async function connectClaimed(row: BindingRow): Promise<void> {
    if (!row.appId || !row.appSecretCipher) throw new Error("Feishu binding has no credentials");
    const { appSecret } = decryptSecret(row.appSecretCipher);
    const client = sdk.createClient({ appId: row.appId, appSecret, loggerLevel: LoggerLevel.warn });
    const channel = sdk.createLarkChannel({
      appId: row.appId,
      appSecret,
      includeRawEvent: true,
      loggerLevel: LoggerLevel.warn,
      source: "first-tree",
      policy: { requireMention: false, dmMode: "open", respondToMentionAll: false },
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 10 },
    });
    channel.on("message", async (message) => {
      try {
        const current = await requireOwnedBinding(row.id, row.connectionEpoch);
        await ingestFeishuMessage(db, notifier, current, message, {
          senderNames,
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
      await db
        .update(imBotBindings)
        .set({
          botOpenId,
          status: "active",
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
        );
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
        lastErrorCode: readErrorCode(error),
        lastErrorMessage: safeErrorMessage(error),
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
    if (!binding || binding.status !== "active" || !binding.appId || !binding.appSecretCipher) {
      throw new NotFoundError("Active Feishu Bot binding not found");
    }
    const { appSecret } = decryptSecret(binding.appSecretCipher);
    return {
      binding,
      appId: binding.appId,
      appSecret,
    };
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
        () => void claimAndMaintain().catch((error) => log.error({ err: error }, "initial Feishu claim failed")),
        initialClaimDelayMs,
      );
      timer = setInterval(
        () => void claimAndMaintain().catch((error) => log.error({ err: error }, "Feishu lease maintenance failed")),
        claimIntervalMs,
      );
    },
    async stop() {
      stopped = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (timer) clearInterval(timer);
      for (const controller of registrations.values()) controller.abort();
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
  };
}

function readCliCapability(metadata: Record<string, unknown> | null | undefined): {
  available: boolean;
  sdkVersion?: string | null;
} | null {
  const capabilities = metadata?.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return null;
  const entry = (capabilities as Record<string, unknown>)["lark-cli"];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const value = entry as Record<string, unknown>;
  return {
    available: value.available === true,
    sdkVersion: typeof value.sdkVersion === "string" ? value.sdkVersion : null,
  };
}

function tenantKeyFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  const event = root.event && typeof root.event === "object" ? (root.event as Record<string, unknown>) : root;
  const sender = event.sender && typeof event.sender === "object" ? (event.sender as Record<string, unknown>) : null;
  return typeof sender?.tenant_key === "string" ? sender.tenant_key : null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : null;
}
