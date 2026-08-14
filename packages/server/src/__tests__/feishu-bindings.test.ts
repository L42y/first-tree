import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectDatabase, sslOptions } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat/conversation.js";
import { completeFeishuOnboarding } from "../services/integrations/feishu/onboarding-completion.js";
import { retireClient, updateClientCapabilities } from "../services/runtime/client.js";
import { ensureMembership } from "../services/team/membership.js";
import { createOrganization } from "../services/team/organization.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

function databaseUrlWithApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function waitForBlockedQuery(
  observer: ReturnType<typeof postgres>,
  blockerPid: number,
  queryPattern: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ pid: number }[]>`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        AND query ILIKE ${queryPattern}
        AND query ILIKE '%for update%'
    `;
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for blocked query: ${queryPattern}`);
}

async function waitForApplicationLock(observer: ReturnType<typeof postgres>, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ wait_event_type: string | null }[]>`
      SELECT wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
        AND query ILIKE '%update "agents"%'
    `;
    if (rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}

describe("Feishu binding lifecycle", () => {
  const getApp = useTestApp();

  it("soft-revokes credentials and mappings, then permits a replacement binding", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const chat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [] });
    const foreignInstanceId = `foreign-${crypto.randomUUID()}`;
    await app.db.insert(serverInstances).values({ instanceId: foreignInstanceId, lastHeartbeat: new Date() });
    const [binding] = await app.db
      .insert(imBotBindings)
      .values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
        appId: `cli_${crypto.randomUUID()}`,
        botOpenId: "ou_bot",
        appSecretCipher: "encrypted-secret",
        status: "active",
        connectionStatus: "connected",
        connectionOwnerInstanceId: foreignInstanceId,
        connectionLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      })
      .returning();
    if (!binding) throw new Error("binding setup failed");
    await app.db.insert(imChatBindings).values({
      id: `chat-binding-${crypto.randomUUID()}`,
      botBindingId: binding.id,
      feishuChatId: "oc_feishu",
      chatId: chat.id,
      feishuChatType: "group",
    });

    await expect(
      app.db.insert(imBotBindings).values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
      }),
    ).rejects.toThrow();

    await app.feishuIntegration.revoke(a.agent.uuid);
    const [revoked] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, binding.id));
    expect(revoked).toMatchObject({
      status: "revoked",
      appSecretCipher: null,
      registrationStateCipher: null,
      connectionStatus: "disconnected",
      connectionOwnerInstanceId: null,
      connectionLeaseExpiresAt: null,
    });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    const [detached] = await app.db.select().from(imChatBindings).where(eq(imChatBindings.botBindingId, binding.id));
    expect(detached?.status).toBe("detached");

    await expect(
      app.db.insert(imBotBindings).values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
      }),
    ).resolves.toBeDefined();
  });

  it("keeps one Bot plus Feishu chat mapped to one canonical chat", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const firstChat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [] });
    const secondChat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [] });
    const [binding] = await app.db
      .insert(imBotBindings)
      .values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
      })
      .returning();
    if (!binding) throw new Error("binding setup failed");
    await app.db.insert(imChatBindings).values({
      id: `chat-binding-${crypto.randomUUID()}`,
      botBindingId: binding.id,
      feishuChatId: "oc_feishu",
      chatId: firstChat.id,
      feishuChatType: "group",
    });
    await expect(
      app.db.insert(imChatBindings).values({
        id: `chat-binding-${crypto.randomUUID()}`,
        botBindingId: binding.id,
        feishuChatId: "oc_feishu",
        chatId: secondChat.id,
        feishuChatType: "group",
      }),
    ).rejects.toThrow();
  });

  it("keeps an expiring connection-owner snapshot when a server instance is removed", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const ownerInstanceId = `owner-${crypto.randomUUID()}`;
    const leaseExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await app.db.insert(serverInstances).values({ instanceId: ownerInstanceId, lastHeartbeat: new Date() });
    const [binding] = await app.db
      .insert(imBotBindings)
      .values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
        connectionOwnerInstanceId: ownerInstanceId,
        connectionLeaseExpiresAt: leaseExpiresAt,
      })
      .returning();
    if (!binding) throw new Error("binding setup failed");

    await app.db.delete(serverInstances).where(eq(serverInstances.instanceId, ownerInstanceId));

    const [persisted] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, binding.id));
    expect(persisted?.connectionOwnerInstanceId).toBe(ownerInstanceId);
    expect(persisted?.connectionLeaseExpiresAt?.getTime()).toBe(leaseExpiresAt.getTime());
  });
});

describe("Feishu onboarding completion", () => {
  const getApp = useTestApp();

  type Seed = Awaited<ReturnType<typeof createTestAgent>> & { bindingId: string };

  async function seedReadyHandoff(app: FastifyInstance): Promise<Seed> {
    const seed = await createTestAgent(app, { displayName: "OpenTag Agent", visibility: "organization" });
    await app.db
      .update(clients)
      .set({
        metadata: {
          capabilities: {
            "lark-cli": { available: true, sdkVersion: "1.4.0" },
          },
        },
      })
      .where(eq(clients.id, seed.clientId));
    const bindingId = `binding-${crypto.randomUUID()}`;
    await app.db.insert(imBotBindings).values({
      id: bindingId,
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      appId: `cli_${crypto.randomUUID()}`,
      botOpenId: `ou_${crypto.randomUUID()}`,
      appSecretCipher: "encrypted-secret",
      status: "active",
      connectionStatus: "connected",
      connectionOwnerInstanceId: `owner-${crypto.randomUUID()}`,
      connectionLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    return { ...seed, bindingId };
  }

  function requestCompletion(
    app: FastifyInstance,
    accessToken: string,
    agentUuid: string,
    payload: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentUuid}/feishu-binding/onboarding-completed`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload,
    });
  }

  async function readCompletion(app: FastifyInstance, memberId: string) {
    const [membership] = await app.db
      .select({
        completedAt: members.onboardingCompletedAt,
        suppressedAt: members.onboardingSuppressedAt,
        suppressedReason: members.onboardingSuppressedReason,
      })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    return membership;
  }

  it("atomically stamps the exact manager after Bot and current-Client readiness pass", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);

    const response = await requestCompletion(app, seed.accessToken, seed.agent.uuid);

    expect(response.statusCode).toBe(200);
    const completedAt = response.json<{ completedAt: string }>().completedAt;
    expect(completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const membership = await readCompletion(app, seed.memberId);
    expect(membership?.completedAt?.toISOString()).toBe(completedAt);
    expect(membership?.suppressedAt?.toISOString()).toBe(completedAt);
    expect(membership?.suppressedReason).toBe("completed");
  });

  it("returns the original stamp on an authorized retry without rechecking degraded readiness", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);
    const first = await requestCompletion(app, seed.accessToken, seed.agent.uuid);
    const firstStamp = first.json<{ completedAt: string }>().completedAt;
    await app.db
      .update(imBotBindings)
      .set({ connectionStatus: "disconnected", connectionOwnerInstanceId: null, connectionLeaseExpiresAt: null })
      .where(eq(imBotBindings.agentId, seed.agent.uuid));
    await app.db
      .update(clients)
      .set({ metadata: { capabilities: { "lark-cli": { available: false } } } })
      .where(eq(clients.id, seed.clientId));

    const retry = await requestCompletion(app, seed.accessToken, seed.agent.uuid);

    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ completedAt: string }>().completedAt).toBe(firstStamp);
    expect((await readCompletion(app, seed.memberId))?.completedAt?.toISOString()).toBe(firstStamp);
  });

  it("rejects ownership loss even when the caller remains an organization admin", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);
    const nextManager = await createTestAdmin(app, { username: `next-${crypto.randomUUID().slice(0, 8)}` });
    await app.db.update(agents).set({ managerId: nextManager.memberId }).where(eq(agents.uuid, seed.agent.uuid));

    const response = await requestCompletion(app, seed.accessToken, seed.agent.uuid);

    expect(response.statusCode).toBe(404);
    expect(await readCompletion(app, seed.memberId)).toEqual({
      completedAt: null,
      suppressedAt: null,
      suppressedReason: null,
    });
  });

  it("rejects Bot reachability loss without stamping completion", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);
    await app.db
      .update(imBotBindings)
      .set({ connectionLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(imBotBindings.agentId, seed.agent.uuid));

    const response = await requestCompletion(app, seed.accessToken, seed.agent.uuid);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe("feishu-bot-unreachable");
    expect((await readCompletion(app, seed.memberId))?.completedAt).toBeNull();
  });

  it("rejects CLI readiness loss committed after the initial Client read", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);
    let reportClientRead = (): void => undefined;
    const clientRead = new Promise<void>((resolve) => {
      reportClientRead = resolve;
    });
    let releaseStamp = (): void => undefined;
    const stampRelease = new Promise<void>((resolve) => {
      releaseStamp = resolve;
    });
    const completion = completeFeishuOnboarding(
      app.db,
      {
        userId: seed.userId,
        organizationId: seed.organizationId,
        agentUuid: seed.agent.uuid,
      },
      {
        afterClientReadForTest: async () => {
          reportClientRead();
          await stampRelease;
        },
      },
    );

    try {
      await clientRead;
      await updateClientCapabilities(app.db, seed.clientId, {
        "lark-cli": {
          state: "missing",
          available: false,
          detectedAt: new Date().toISOString(),
        },
      });
      releaseStamp();

      await expect(completion).rejects.toMatchObject({
        statusCode: 409,
        attrs: { code: "feishu-cli-not-ready" },
      });
      expect((await readCompletion(app, seed.memberId))?.completedAt).toBeNull();
    } finally {
      releaseStamp();
      await Promise.allSettled([completion]);
    }
  });

  it("completes without a Client-lock cycle while retirement waits for the Agent", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const retirementApplicationName = `feishu_retire_${crypto.randomUUID().slice(0, 8)}`;
    const retirementDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, retirementApplicationName));
    const botBlocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    let releaseBot = (): void => undefined;
    const botRelease = new Promise<void>((resolve) => {
      releaseBot = resolve;
    });
    let reportBotLocked = (_pid: number): void => undefined;
    const botLocked = new Promise<number>((resolve) => {
      reportBotLocked = resolve;
    });
    let botTransaction: Promise<unknown> | undefined;
    let completion: ReturnType<typeof requestCompletion> | undefined;
    let retirement: Promise<void> | undefined;

    try {
      const [backend] = await botBlocker<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      if (!backend) throw new Error("Could not identify the Bot-lock blocker");
      botTransaction = botBlocker.begin(async (tx) => {
        await tx.unsafe("SELECT id FROM im_bot_bindings WHERE id = $1 FOR UPDATE", [seed.bindingId]);
        reportBotLocked(backend.pid);
        await botRelease;
      });
      const blockerPid = await botLocked;

      completion = requestCompletion(app, seed.accessToken, seed.agent.uuid);
      // Completion now owns membership + Agent and is paused only on its Bot.
      await waitForBlockedQuery(observer, blockerPid, '%from "im_bot_bindings"%');

      retirement = retireClient(retirementDb, seed.clientId);
      // retirement owns Client and waits for the Agent held by completion.
      await waitForApplicationLock(observer, retirementApplicationName);
      releaseBot();
      await botTransaction;

      // A Client FOR UPDATE here would complete the Agent -> Client / Client ->
      // Agent cycle. The ordinary readiness read instead lets completion win
      // the linearization race, release Agent, and unblock retirement.
      const response = await completion;
      expect(response.statusCode).toBe(200);
      await retirement;
      expect((await readCompletion(app, seed.memberId))?.suppressedReason).toBe("completed");
      const [retiredClient] = await app.db
        .select({ retiredAt: clients.retiredAt })
        .from(clients)
        .where(eq(clients.id, seed.clientId));
      expect(retiredClient?.retiredAt).toBeInstanceOf(Date);
      const [retiredAgent] = await app.db
        .select({ clientId: agents.clientId, status: agents.status })
        .from(agents)
        .where(eq(agents.uuid, seed.agent.uuid));
      expect(retiredAgent).toMatchObject({ clientId: null, status: "suspended" });
    } finally {
      releaseBot();
      await Promise.allSettled([botTransaction, completion, retirement].filter(Boolean));
      await retirementDb.end();
      await botBlocker.end();
      await observer.end();
    }
  }, 10_000);

  it("validates the Agent's newly selected Client instead of a ready stale Client", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);
    const movedClientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: movedClientId,
      userId: seed.userId,
      organizationId: seed.organizationId,
      status: "connected",
      metadata: { capabilities: { "lark-cli": { available: false } } },
    });
    await app.db.update(agents).set({ clientId: movedClientId }).where(eq(agents.uuid, seed.agent.uuid));

    const response = await requestCompletion(app, seed.accessToken, seed.agent.uuid);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe("feishu-cli-not-ready");
    expect((await readCompletion(app, seed.memberId))?.completedAt).toBeNull();
  });

  it("classifies a missing current Client without stamping completion", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);
    await app.db.update(agents).set({ clientId: null }).where(eq(agents.uuid, seed.agent.uuid));

    const response = await requestCompletion(app, seed.accessToken, seed.agent.uuid);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe("feishu-client-unavailable");
    expect((await readCompletion(app, seed.memberId))?.completedAt).toBeNull();
  });

  it("rejects current-Client CLI readiness loss and succeeds after readiness is repaired", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);
    await app.db
      .update(clients)
      .set({ metadata: { capabilities: { "lark-cli": { available: false } } } })
      .where(eq(clients.id, seed.clientId));

    const rejected = await requestCompletion(app, seed.accessToken, seed.agent.uuid);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<{ code: string }>().code).toBe("feishu-cli-not-ready");
    expect((await readCompletion(app, seed.memberId))?.completedAt).toBeNull();

    await app.db
      .update(clients)
      .set({ metadata: { capabilities: { "lark-cli": { available: true } } } })
      .where(eq(clients.id, seed.clientId));
    const retried = await requestCompletion(app, seed.accessToken, seed.agent.uuid);
    expect(retried.statusCode).toBe(200);
    expect((await readCompletion(app, seed.memberId))?.suppressedReason).toBe("completed");
  });

  it("protects the Class C resource from callers who are active only in another organization", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);
    const outsider = await createTestAdmin(app, { username: `outside-${crypto.randomUUID().slice(0, 8)}` });
    const sideOrg = await createOrganization(app.db, {
      name: `side-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Side Team",
    });
    await ensureMembership(app.db, {
      userId: outsider.userId,
      organizationId: sideOrg.id,
      role: "admin",
      username: outsider.username,
      displayName: "Outside Admin",
    });
    await app.db.update(members).set({ status: "left" }).where(eq(members.id, outsider.memberId));

    const response = await requestCompletion(app, outsider.accessToken, seed.agent.uuid);

    expect(response.statusCode).toBe(404);
    expect((await readCompletion(app, seed.memberId))?.completedAt).toBeNull();
  });

  it("accepts only a strict empty request body", async () => {
    const app = getApp();
    const seed = await seedReadyHandoff(app);

    const response = await requestCompletion(app, seed.accessToken, seed.agent.uuid, { clientId: seed.clientId });

    expect(response.statusCode).toBe(400);
    expect((await readCompletion(app, seed.memberId))?.completedAt).toBeNull();
  });
});

describe("Feishu CLI setup Task", () => {
  const getApp = useTestApp();

  async function requestSetupChat(app: FastifyInstance, accessToken: string, agentUuid: string, retry = false) {
    return app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentUuid}/feishu-binding/setup-chat`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { requestInstall: true, retry },
    });
  }

  /** Backdate every message so a retry is not declined by the burst cooldown. */
  async function agePriorRequests(app: FastifyInstance, chatId: string) {
    await app.db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 10 * 60 * 1_000) })
      .where(eq(messages.chatId, chatId));
  }

  it("returns one Task however many times the same member asks for it", async () => {
    // The automatic OpenTag preparation, a reload, a retry, and a second tab
    // all hit this endpoint for the same Agent on the same Computer. Each one
    // opening its own Task would bury the member's workspace in identical
    // conversations about a machine check they never asked for.
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });

    const first = await requestSetupChat(app, a.accessToken, a.agent.uuid);
    const second = await requestSetupChat(app, a.accessToken, a.agent.uuid);
    const third = await requestSetupChat(app, a.accessToken, a.agent.uuid);

    expect(first.statusCode).toBe(201);
    const chatId = first.json<{ chatId: string }>().chatId;
    expect(second.json<{ chatId: string }>().chatId).toBe(chatId);
    expect(third.json<{ chatId: string }>().chatId).toBe(chatId);

    // The reuse is a real reuse, not three chats sharing a response shape.
    const opening = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(opening).toHaveLength(1);
  });

  it("opens a new Task when the Agent moves to another Computer", async () => {
    // The capability the Task establishes is a fact about one machine, so a
    // move genuinely needs a new check there. Reusing the old Computer's Task
    // would answer a question about a machine the Agent no longer runs on.
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const firstChatId = (await requestSetupChat(app, a.accessToken, a.agent.uuid)).json<{ chatId: string }>().chatId;

    const movedClientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: movedClientId,
      userId: a.userId,
      organizationId: a.organizationId,
      status: "connected",
    });
    await app.db.update(agents).set({ clientId: movedClientId }).where(eq(agents.uuid, a.agent.uuid));

    const moved = await requestSetupChat(app, a.accessToken, a.agent.uuid);
    expect(moved.json<{ chatId: string }>().chatId).not.toBe(firstChatId);

    // Moving back converges on the original Task rather than a third one: the
    // key describes the machine, not the order the member visited them in.
    await app.db.update(agents).set({ clientId: a.clientId }).where(eq(agents.uuid, a.agent.uuid));
    const back = await requestSetupChat(app, a.accessToken, a.agent.uuid);
    expect(back.json<{ chatId: string }>().chatId).toBe(firstChatId);
  });

  it("asks the Agent again on an explicit retry, in the Task it already has", async () => {
    // Reuse is not the same as doing nothing. Once the Agent has taken the
    // original request, re-arming it wakes nobody — so a retry that only
    // returned the same chat id would report work that never restarted.
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const chatId = (await requestSetupChat(app, a.accessToken, a.agent.uuid)).json<{ chatId: string }>().chatId;
    await agePriorRequests(app, chatId);

    const retried = await requestSetupChat(app, a.accessToken, a.agent.uuid, true);

    expect(retried.json<{ chatId: string }>().chatId).toBe(chatId);
    const asked = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(asked).toHaveLength(2);
    // The Agent is woken for the new ask, not merely told the Task exists.
    const delivered = await app.db
      .select()
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)));
    expect(delivered).toHaveLength(2);
  });

  it("does not ask again for the loads, reloads and tabs that only ensure the Task", async () => {
    // Ensuring runs on every visit. If that woke the Agent, a background
    // mechanism would become a stream of interruptions about one machine check.
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const chatId = (await requestSetupChat(app, a.accessToken, a.agent.uuid)).json<{ chatId: string }>().chatId;
    await agePriorRequests(app, chatId);

    await requestSetupChat(app, a.accessToken, a.agent.uuid);
    await requestSetupChat(app, a.accessToken, a.agent.uuid);

    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(1);
  });

  it("collapses a burst of retries into one request at the Agent", async () => {
    // Two tabs sitting on the recovery state, or one impatient double click,
    // are one intent — not three identical asks.
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const chatId = (await requestSetupChat(app, a.accessToken, a.agent.uuid)).json<{ chatId: string }>().chatId;
    await agePriorRequests(app, chatId);

    await requestSetupChat(app, a.accessToken, a.agent.uuid, true);
    await requestSetupChat(app, a.accessToken, a.agent.uuid, true);
    await requestSetupChat(app, a.accessToken, a.agent.uuid, true);

    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(2);
  });

  it("keeps one administrator out of another's private setup Task", async () => {
    // The Task is a private conversation between one human and one Agent. Two
    // admins may both manage the same Agent, and joining the second one to the
    // first one's chat would hand them a private history they were never in.
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const other = await createTestAdmin(app, { username: `admin-${crypto.randomUUID().slice(0, 8)}` });

    const mine = (await requestSetupChat(app, a.accessToken, a.agent.uuid)).json<{ chatId: string }>().chatId;
    const theirs = await requestSetupChat(app, other.accessToken, a.agent.uuid);

    expect(theirs.statusCode).toBe(201);
    expect(theirs.json<{ chatId: string }>().chatId).not.toBe(mine);
  });
});
