import { RUNTIME_NOTICE_METADATA_KEY } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FEISHU_AGENT_CHAT_WRITE_CODE } from "../api/agent/feishu-chat-guard.js";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat/conversation.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Agent-scope mirror of `feishu-web-readonly.test.ts`. The Web boundary keeps
 * a Feishu-bridged chat readable but structurally immutable for the signed-in
 * user; this pins the symmetric boundary for the agent's own chat tools, whose
 * writes would otherwise land where no Feishu human can see them.
 */
describe("Feishu agent chat-tool boundary", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const b = await createTestAgent(app, { displayName: "Agent B" });
    const c = await createTestAgent(app, { displayName: "Agent C" });
    const chat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [b.agent.uuid] });
    const foreignInstanceId = `foreign-${crypto.randomUUID()}`;
    await app.db.insert(serverInstances).values({ instanceId: foreignInstanceId, lastHeartbeat: new Date() });
    const [botBinding] = await app.db
      .insert(imBotBindings)
      .values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
        appId: `cli_${crypto.randomUUID()}`,
        botOpenId: "ou_bot",
        tenantKey: "tenant-a",
        appSecretCipher: "encrypted-test-secret",
        status: "active",
        connectionStatus: "connected",
        connectionOwnerInstanceId: foreignInstanceId,
        connectionLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      })
      .returning();
    if (!botBinding) throw new Error("binding setup failed");
    const chatBindingId = `chat-binding-${crypto.randomUUID()}`;
    await app.db.insert(imChatBindings).values({
      id: chatBindingId,
      botBindingId: botBinding.id,
      feishuChatId: "oc_feishu",
      chatId: chat.id,
      feishuChatType: "group",
      status: "active",
    });
    return { app, a, b, c, chat, chatBindingId };
  }

  it("rejects `chat send`, `chat ask` and `chat invite` with an actionable code", async () => {
    const { a, b, c, chat } = await setup();

    const send = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "text",
      content: "this would vanish",
      source: "cli",
      metadata: { mentions: [b.agent.uuid] },
    });
    expect(send.statusCode).toBe(403);
    const sendBody = send.json<{ code?: string; error: string }>();
    expect(sendBody.code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);
    // The refusal must name the path that actually delivers, not just refuse.
    expect(sendBody.error).toContain("feishu intent");
    expect(sendBody.error).toContain("lark-cli");

    // `chat ask` is the same route with `format: "request"` — one guard covers both.
    const ask = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "request",
      content: "should I proceed?",
      source: "cli",
      metadata: { mentions: [b.agent.uuid] },
    });
    expect(ask.statusCode).toBe(403);
    expect(ask.json<{ code?: string }>().code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);

    const invite = await a.request("POST", `/api/v1/agent/chats/${chat.id}/participants`, {
      agentIds: [c.agent.uuid],
    });
    expect(invite.statusCode).toBe(403);
    expect(invite.json<{ code?: string }>().code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);
  });

  it("keeps reads, `chat update` and the bridge signal working", async () => {
    const { a, chat } = await setup();

    const detail = await a.request("GET", `/api/v1/agent/chats/${chat.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ externalChannel: string | null }>().externalChannel).toBe("feishu");

    const history = await a.request("GET", `/api/v1/agent/chats/${chat.id}/messages`);
    expect(history.statusCode).toBe(200);

    const participants = await a.request("GET", `/api/v1/agent/chats/${chat.id}/participants`);
    expect(participants.statusCode).toBe(200);

    // Deliberately still allowed: the agent briefing requires it to keep the
    // chat's topic/description current, and neither is a message to a human.
    const update = await a.request("PATCH", `/api/v1/agent/chats/${chat.id}`, {
      topic: "Feishu bridge triage",
      description: "Answering in the Feishu group.",
    });
    expect(update.statusCode).toBe(200);
  });

  /**
   * The exemption is a property of the ROUTE, so the genuine runtime notice
   * has to keep landing: an agent that cannot run at all must not also go
   * silent on the operator watching the chat.
   */
  it("delivers a genuine runtime notice through the dedicated route and marks it server-side", async () => {
    const { app, a, chat } = await setup();

    const notice = await a.request("POST", `/api/v1/agent/chats/${chat.id}/runtime-notices`, {
      content: "Claude Code could not run this turn: credentials need attention.",
    });
    expect(notice.statusCode).toBe(201);

    const [stored] = await app.db.select().from(messages).where(eq(messages.id, notice.json<{ id: string }>().id));
    expect(stored?.metadata).toMatchObject({ [RUNTIME_NOTICE_METADATA_KEY]: true });
  });

  /**
   * Regression for the forgeable exemption. Both markers used to be read off
   * the request body, so any agent credential could mint its own bypass of the
   * 403 by decorating an ordinary `chat send`.
   */
  it("rejects a forged runtime notice from an ordinary agent credential", async () => {
    const { app, a, b, chat } = await setup();

    const forged = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "text",
      content: "arbitrary content wearing a runtime-notice costume",
      source: "cli",
      purpose: "agent-final-text",
      metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json<{ code?: string }>().code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);

    // The silent delivery profile alone never opened the door either.
    const bareFinalText = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "text",
      content: "not a runtime notice",
      source: "cli",
      purpose: "agent-final-text",
    });
    expect(bareFinalText.statusCode).toBe(403);
    expect(bareFinalText.json<{ code?: string }>().code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);

    // And even in an ORDINARY chat, where the send succeeds, the smuggled
    // marker must not survive onto the stored row — otherwise the forgery just
    // moves one chat over.
    const plain = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [b.agent.uuid] });
    const smuggled = await a.request("POST", `/api/v1/agent/chats/${plain.id}/messages`, {
      format: "text",
      content: "ordinary send carrying the marker",
      source: "cli",
      metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true, mentions: [b.agent.uuid] },
    });
    expect(smuggled.statusCode).toBe(201);
    const [stored] = await app.db.select().from(messages).where(eq(messages.id, smuggled.json<{ id: string }>().id));
    expect(stored?.metadata).not.toHaveProperty(RUNTIME_NOTICE_METADATA_KEY);
  });

  /**
   * The notice route is a narrower capability, not an open door: it still
   * requires membership, and it refuses to let the caller shape the stored row.
   */
  it("keeps the runtime-notice route membership-gated and strict about its body", async () => {
    const { a, c, chat } = await setup();

    const outsider = await c.request("POST", `/api/v1/agent/chats/${chat.id}/runtime-notices`, {
      content: "not my chat",
    });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json<{ code?: string }>().code).not.toBe(FEISHU_AGENT_CHAT_WRITE_CODE);

    const overreaching = await a.request("POST", `/api/v1/agent/chats/${chat.id}/runtime-notices`, {
      content: "trying to address a teammate",
      metadata: { mentions: [c.agent.uuid] },
    });
    expect(overreaching.statusCode).toBe(400);
  });

  /**
   * The guard must not become an oracle: a non-member who guesses a chat UUID
   * should not be able to tell a Feishu-bound chat from an ordinary one by the
   * difference in error.
   */
  it("authorizes membership before the boundary, so the 403 cannot be probed", async () => {
    const { app, a, b, c, chat } = await setup();
    const plain = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [b.agent.uuid] });

    for (const target of [chat, plain]) {
      const invite = await c.request("POST", `/api/v1/agent/chats/${target.id}/participants`, {
        agentIds: [c.agent.uuid],
      });
      expect(invite.statusCode).toBe(403);
      expect(invite.json<{ code?: string }>().code).not.toBe(FEISHU_AGENT_CHAT_WRITE_CODE);

      const send = await c.request("POST", `/api/v1/agent/chats/${target.id}/messages`, {
        format: "text",
        content: "probing",
        source: "cli",
        metadata: { mentions: [a.agent.uuid] },
      });
      expect(send.statusCode).toBe(403);
      expect(send.json<{ code?: string }>().code).not.toBe(FEISHU_AGENT_CHAT_WRITE_CODE);
    }
  });

  it("releases the boundary once the Feishu binding detaches", async () => {
    const { app, a, b, chat, chatBindingId } = await setup();

    await app.db.update(imChatBindings).set({ status: "detached" }).where(eq(imChatBindings.id, chatBindingId));

    const detail = await a.request("GET", `/api/v1/agent/chats/${chat.id}`);
    expect(detail.json<{ externalChannel: string | null }>().externalChannel).toBeNull();

    const send = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "text",
      content: "the bridge is gone; this is an ordinary chat again",
      source: "cli",
      metadata: { mentions: [b.agent.uuid] },
    });
    expect(send.statusCode).toBe(201);
  });

  it("leaves an unbridged chat untouched", async () => {
    const { app, a, b } = await setup();
    const plain = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [b.agent.uuid] });

    const detail = await a.request("GET", `/api/v1/agent/chats/${plain.id}`);
    expect(detail.json<{ externalChannel: string | null }>().externalChannel).toBeNull();

    const send = await a.request("POST", `/api/v1/agent/chats/${plain.id}/messages`, {
      format: "text",
      content: "ordinary send",
      source: "cli",
      metadata: { mentions: [b.agent.uuid] },
    });
    expect(send.statusCode).toBe(201);
  });
});
