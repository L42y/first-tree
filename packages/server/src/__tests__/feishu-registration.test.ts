import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { encryptCredentials } from "../services/crypto.js";
import { createFeishuIntegrationManager, type FeishuSdkDependencies } from "../services/integrations/feishu/manager.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

const sdkMocks = (() => {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue(undefined);
  const addReaction = vi.fn().mockResolvedValue("reaction-ack");
  const request = vi.fn().mockResolvedValue({
    code: 0,
    msg: "ok",
    bot: {
      app_name: "Agent A · First Tree",
      avatar_url: "https://example.com/agent-a.png",
      open_id: "ou_created_bot",
    },
  });
  const channel = {
    botIdentity: { openId: "ou_created_bot" },
    on: vi.fn((name: string, handler: (payload: unknown) => unknown) => {
      handlers.set(name, handler);
      return channel;
    }),
    addReaction,
    connect,
    disconnect,
  };
  return {
    handlers,
    channel,
    addReaction,
    connect,
    disconnect,
    request,
    registerApp: vi.fn(async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=test", expireIn: 120 });
      return { client_id: "cli_created", client_secret: "secret-created-by-feishu" };
    }),
    createLarkChannel: vi.fn((_options: Parameters<FeishuSdkDependencies["createLarkChannel"]>[0]) => channel),
    createClient: vi.fn((_options: Parameters<FeishuSdkDependencies["createClient"]>[0]) => ({
      request,
      im: {
        v1: {
          chatMembers: { get: vi.fn() },
          messageResource: { get: vi.fn() },
        },
      },
    })),
  };
})();

const feishuSdk = sdkMocks as unknown as FeishuSdkDependencies;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function receivedMessage(id: string) {
  return {
    messageId: `om_${id}`,
    chatId: "oc_acknowledge",
    chatType: "p2p",
    senderId: "ou_human",
    senderName: "Human",
    content: "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    raw: {
      header: { event_id: `event_${id}` },
      event: {
        sender: { tenant_key: "tenant-a", sender_id: { open_id: "ou_human" } },
        message: { message_type: "text", content: JSON.stringify({ text: "hello" }) },
      },
    },
  };
}

describe("official Feishu QR registration", () => {
  const getApp = useTestApp({ feishuSdk });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMocks.handlers.clear();
    sdkMocks.channel.botIdentity = { openId: "ou_created_bot" };
    sdkMocks.connect.mockResolvedValue(undefined);
    sdkMocks.disconnect.mockResolvedValue(undefined);
    sdkMocks.addReaction.mockResolvedValue("reaction-ack");
  });

  it("rejects Bot registration for a private Agent", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Private Agent", visibility: "private" });

    await expect(
      app.feishuIntegration.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Private Agent · First Tree",
      }),
    ).rejects.toThrow("Feishu Bot binding requires an organization-visible Agent");
    expect(sdkMocks.registerApp).not.toHaveBeenCalled();
    expect(await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid))).toEqual([]);
  });

  it("uses registerApp, encrypts the returned secret, and activates the connected Bot", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    await app.db
      .insert(serverInstances)
      .values({ instanceId: "test-instance", lastHeartbeat: new Date() })
      .onConflictDoNothing();
    const initial = await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });

    expect(initial.registrationUrl).toBe("https://open.feishu.cn/register?code=test");
    expect(sdkMocks.registerApp).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "first-tree",
        createOnly: true,
        appPreset: expect.objectContaining({ name: "Agent A · First Tree" }),
        addons: expect.objectContaining({
          events: { items: { tenant: ["im.message.receive_v1"] } },
        }),
      }),
    );

    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      if (row?.status === "error") {
        throw new Error(`registration failed: ${row.lastErrorCode ?? "unknown"} ${row.lastErrorMessage ?? ""}`);
      }
      return row?.status === "active" && row.botName === "Agent A · First Tree";
    });
    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({
      appId: "cli_created",
      botOpenId: "ou_created_bot",
      botName: "Agent A · First Tree",
      botAvatarUrl: "https://example.com/agent-a.png",
      status: "active",
      connectionStatus: "connected",
      registrationStateCipher: null,
    });
    expect(stored?.appSecretCipher).not.toBe("secret-created-by-feishu");
    expect(stored?.appSecretCipher).toEqual(expect.any(String));
    expect(sdkMocks.createLarkChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "cli_created",
        appSecret: "secret-created-by-feishu",
        includeRawEvent: true,
        policy: { requireMention: false, dmMode: "open", respondToMentionAll: false },
      }),
    );
    expect(sdkMocks.connect).toHaveBeenCalledTimes(1);
    expect(sdkMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", url: "/open-apis/bot/v3/info", signal: expect.any(AbortSignal) }),
    );
    const clientOptions = sdkMocks.createClient.mock.calls[0]?.[0];
    const channelOptions = sdkMocks.createLarkChannel.mock.calls[0]?.[0];
    expect(channelOptions?.logger).toBe(clientOptions?.logger);
    const consoleSpies = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    const sensitiveError = Object.assign(new Error('Bearer tenant-secret {"app_secret":"bot-secret"}'), {
      config: { headers: { Authorization: "Bearer tenant-secret" }, data: { app_secret: "bot-secret" } },
    });
    await channelOptions?.logger?.error(sensitiveError);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls).join(" ")).not.toMatch(/tenant-secret|bot-secret/);

    await app.db
      .update(imBotBindings)
      .set({ connectionEpoch: (stored?.connectionEpoch ?? 0) + 1 })
      .where(eq(imBotBindings.id, stored?.id ?? "missing"));
    const staleMessageHandler = sdkMocks.handlers.get("message");
    expect(staleMessageHandler).toBeTypeOf("function");
    await staleMessageHandler?.({ messageId: "om_stale" });
    expect(sdkMocks.addReaction).not.toHaveBeenCalled();
    expect(await app.db.select().from(messages)).toEqual([]);
    const [afterStaleEvent] = await app.db
      .select({ lastEventAt: imBotBindings.lastEventAt })
      .from(imBotBindings)
      .where(eq(imBotBindings.id, stored?.id ?? "missing"));
    expect(afterStaleEvent?.lastEventAt).toBeNull();
  });

  it("keeps the Bot connected when profile metadata cannot be loaded", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    sdkMocks.request.mockRejectedValueOnce(new Error("Feishu Bot info unavailable"));

    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });

    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({
      status: "active",
      connectionStatus: "connected",
      botName: null,
      botAvatarUrl: null,
    });
  });

  it("uses the owned Bot channel to acknowledge an admitted message", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });

    const messageHandler = sdkMocks.handlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    await messageHandler?.(receivedMessage("acknowledge"));

    await vi.waitFor(() => expect(sdkMocks.addReaction).toHaveBeenCalledWith("om_acknowledge", "Get"));
    expect(await app.db.select().from(messages)).toHaveLength(1);
    await app.feishuIntegration.revoke(a.agent.uuid);
  });

  it("bounds acknowledgement reactions when provider calls never settle", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    sdkMocks.addReaction.mockImplementation(() => new Promise<string>(() => undefined));
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });

    const messageHandler = sdkMocks.handlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    for (let index = 0; index < 20; index += 1) {
      await messageHandler?.(receivedMessage(`bounded_${index}`));
    }

    await vi.waitFor(() => expect(sdkMocks.addReaction).toHaveBeenCalledTimes(16));
    expect(await app.db.select().from(messages)).toHaveLength(20);
    await app.feishuIntegration.revoke(a.agent.uuid);
  });

  it("maintains the provisioning lease while connection and Bot profile enrichment are pending", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const connectStarted = deferred<void>();
    const connectCompletion = deferred<void>();
    sdkMocks.connect.mockImplementationOnce(() => {
      connectStarted.resolve();
      return connectCompletion.promise;
    });
    sdkMocks.request.mockImplementationOnce(() => new Promise(() => undefined));
    const manager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      instanceId: "profile-timeout-test",
      sdk: feishuSdk,
      timings: {
        initialClaimDelayMs: 60_000,
        claimIntervalMs: 20,
        leaseMs: 500,
        botProfileTimeoutMs: 80,
      },
    });
    manager.start();
    try {
      await manager.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      });
      await connectStarted.promise;
      const [provisioning] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      expect(provisioning).toMatchObject({
        status: "provisioning",
        connectionStatus: "connecting",
        connectionOwnerInstanceId: "profile-timeout-test",
      });
      if (!provisioning?.connectionLeaseExpiresAt) throw new Error("expected the provisioning lease");
      const initialLeaseExpiry = provisioning.connectionLeaseExpiresAt.getTime();

      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, provisioning.id));
        return (
          sdkMocks.disconnect.mock.calls.length > 0 ||
          (row?.connectionLeaseExpiresAt?.getTime() ?? 0) > initialLeaseExpiry
        );
      });
      const [renewed] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, provisioning.id));
      expect(renewed?.connectionLeaseExpiresAt?.getTime()).toBeGreaterThan(initialLeaseExpiry);
      expect(sdkMocks.disconnect).not.toHaveBeenCalled();

      connectCompletion.resolve();
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
        return row?.status === "active" && row.connectionStatus === "connected";
      });

      const [maintained] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      expect(maintained).toMatchObject({
        status: "active",
        connectionStatus: "connected",
        connectionOwnerInstanceId: "profile-timeout-test",
        botName: null,
      });
      expect(sdkMocks.createLarkChannel).toHaveBeenCalledTimes(1);
      expect(sdkMocks.disconnect).not.toHaveBeenCalled();
    } finally {
      connectCompletion.resolve();
      await new Promise((resolve) => setTimeout(resolve, 70));
      await manager.stop();
    }
  });

  it("lets a second replica take over an expired lease with a higher fencing epoch", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const bindingId = `binding-${crypto.randomUUID()}`;
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await app.db.insert(imBotBindings).values({
      id: bindingId,
      organizationId: a.organizationId,
      agentId: a.agent.uuid,
      appId: "cli_takeover",
      botOpenId: "ou_created_bot",
      appSecretCipher: encryptCredentials({ appSecret: "secret-created-by-feishu" }, encryptionKey),
      status: "active",
      connectionStatus: "connected",
      connectionOwnerInstanceId: "retired-replica",
      connectionLeaseExpiresAt: new Date(Date.now() - 1_000),
      connectionEpoch: 7,
    });

    const replica = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: "replacement-replica",
      sdk: feishuSdk,
      timings: { initialClaimDelayMs: 1, claimIntervalMs: 60_000, leaseMs: 10_000 },
    });
    replica.start();
    try {
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, bindingId));
        return row?.connectionOwnerInstanceId === "replacement-replica" && row.connectionStatus === "connected";
      });
      const [claimed] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, bindingId));
      expect(claimed).toMatchObject({
        connectionOwnerInstanceId: "replacement-replica",
        connectionEpoch: 8,
        connectionStatus: "connected",
      });
      expect(claimed?.connectionLeaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await replica.stop();
    }
  });

  it("does not let a late registration success revive a revoked binding", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(
      async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=late", expireIn: 120 });
        return completion.promise;
      },
    );

    const initial = await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    expect(initial.registrationUrl).toContain("code=late");

    await app.feishuIntegration.revoke(a.agent.uuid);
    completion.resolve({ client_id: "cli_late", client_secret: "late-secret" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({
      status: "revoked",
      appId: null,
      appSecretCipher: null,
      registrationStateCipher: null,
    });
    expect(sdkMocks.createLarkChannel).not.toHaveBeenCalled();
  });

  it("settles a registration revoked before QR even when the provider ignores abort", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(async () => completion.promise);

    const pending = app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db
        .select({ id: imBotBindings.id })
        .from(imBotBindings)
        .where(eq(imBotBindings.agentId, a.agent.uuid));
      return Boolean(row);
    });

    const rejected = expect(pending).rejects.toThrow("Feishu registration was revoked");
    await app.feishuIntegration.revoke(a.agent.uuid);
    await rejected;
    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({ status: "revoked", registrationStateCipher: null });
  });

  it("settles a registration stopped before QR even when the provider ignores abort", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    const stoppedSdk = {
      ...feishuSdk,
      registerApp: vi.fn(async () => completion.promise),
    } as FeishuSdkDependencies;
    const manager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      instanceId: "registration-stop-test",
      sdk: stoppedSdk,
    });

    const pending = manager.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db
        .select({ id: imBotBindings.id })
        .from(imBotBindings)
        .where(eq(imBotBindings.agentId, a.agent.uuid));
      return Boolean(row);
    });

    const rejected = expect(pending).rejects.toThrow("Feishu integration manager stopped");
    await manager.stop();
    await rejected;
    completion.resolve({ client_id: "cli_after_stop", client_secret: "late-secret" });
  });

  it("does not let a late registration failure overwrite a revoked binding", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(
      async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=late-failure", expireIn: 120 });
        return completion.promise;
      },
    );

    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await app.feishuIntegration.revoke(a.agent.uuid);
    completion.reject(new Error("provider failed after revoke"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({ status: "revoked", lastErrorCode: null, lastErrorMessage: null });
  });

  it("hides a live registration URL from an org-visible non-manager", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(
      async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=manager-only", expireIn: 120 });
        return completion.promise;
      },
    );
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });

    const viewer = await createTestAdmin(app, { username: `viewer-${crypto.randomUUID().slice(0, 8)}` });
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, viewer.memberId));
    const visible = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${a.agent.uuid}/feishu-binding`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json<{ binding: { registrationUrl: string | null } }>().binding.registrationUrl).toBeNull();

    const manager = await a.request("GET", `/api/v1/agents/${a.agent.uuid}/feishu-binding`);
    expect(manager.statusCode).toBe(200);
    expect(manager.json<{ binding: { registrationUrl: string | null } }>().binding.registrationUrl).toContain(
      "manager-only",
    );

    await app.feishuIntegration.revoke(a.agent.uuid);
    completion.resolve({ client_id: "cli_late", client_secret: "late-secret" });
  });

  it("aborts a QR registration timeout and ignores late provider callbacks", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    let providerSignal: AbortSignal | undefined;
    const timeoutSdk = {
      ...feishuSdk,
      registerApp: vi.fn(async (options: { signal: AbortSignal }) => {
        providerSignal = options.signal;
        return completion.promise;
      }),
    } as FeishuSdkDependencies;
    const manager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      instanceId: "registration-timeout-test",
      sdk: timeoutSdk,
      timings: { registrationQrTimeoutMs: 10 },
    });

    await expect(
      manager.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      }),
    ).rejects.toThrow("Timed out waiting for Feishu registration QR code");
    expect(providerSignal?.aborted).toBe(true);

    completion.resolve({ client_id: "cli_after_timeout", client_secret: "late-secret" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({ status: "error", appId: null, appSecretCipher: null });
  });

  it("rejects a QR callback that arrives after timeout while the provider stays pending", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    let onQRCodeReady: ((value: { url: string; expireIn: number }) => void) | undefined;
    const timeoutSdk = {
      ...feishuSdk,
      registerApp: vi.fn(async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
        onQRCodeReady = options.onQRCodeReady;
        return completion.promise;
      }),
    } as FeishuSdkDependencies;
    const manager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      instanceId: "registration-late-qr-test",
      sdk: timeoutSdk,
      timings: { registrationQrTimeoutMs: 10 },
    });

    await expect(
      manager.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      }),
    ).rejects.toThrow("Timed out waiting for Feishu registration QR code");
    onQRCodeReady?.({ url: "https://open.feishu.cn/register?code=too-late", expireIn: 120 });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({ status: "error", registrationExpiresAt: null });
  });
});
