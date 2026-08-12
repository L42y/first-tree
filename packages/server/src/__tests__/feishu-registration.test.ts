import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { encryptCredentials } from "../services/crypto.js";
import { createFeishuIntegrationManager, type FeishuSdkDependencies } from "../services/integrations/feishu/manager.js";
import { createTestAgent, useTestApp } from "./helpers.js";

const sdkMocks = (() => {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue(undefined);
  const channel = {
    botIdentity: { openId: "ou_created_bot" },
    on: vi.fn((name: string, handler: (payload: unknown) => unknown) => {
      handlers.set(name, handler);
      return channel;
    }),
    connect,
    disconnect,
  };
  return {
    handlers,
    channel,
    connect,
    disconnect,
    registerApp: vi.fn(async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=test", expireIn: 120 });
      return { client_id: "cli_created", client_secret: "secret-created-by-feishu" };
    }),
    createLarkChannel: vi.fn(() => channel),
    createClient: vi.fn(() => ({
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

describe("official Feishu QR registration", () => {
  const getApp = useTestApp({ feishuSdk });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMocks.handlers.clear();
    sdkMocks.channel.botIdentity = { openId: "ou_created_bot" };
    sdkMocks.connect.mockResolvedValue(undefined);
    sdkMocks.disconnect.mockResolvedValue(undefined);
  });

  it("uses registerApp, encrypts the returned secret, and activates the connected Bot", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
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
      return row?.status === "active";
    });
    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({
      appId: "cli_created",
      botOpenId: "ou_created_bot",
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

    await app.db
      .update(imBotBindings)
      .set({ connectionEpoch: (stored?.connectionEpoch ?? 0) + 1 })
      .where(eq(imBotBindings.id, stored?.id ?? "missing"));
    const staleMessageHandler = sdkMocks.handlers.get("message");
    expect(staleMessageHandler).toBeTypeOf("function");
    await staleMessageHandler?.({ messageId: "om_stale" });
    expect(await app.db.select().from(messages)).toEqual([]);
    const [afterStaleEvent] = await app.db
      .select({ lastEventAt: imBotBindings.lastEventAt })
      .from(imBotBindings)
      .where(eq(imBotBindings.id, stored?.id ?? "missing"));
    expect(afterStaleEvent?.lastEventAt).toBeNull();
  });

  it("lets a second replica take over an expired lease with a higher fencing epoch", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
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
});
