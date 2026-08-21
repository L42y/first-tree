import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { createAgent, getAgent } from "../services/agents/identity.js";
import { addParticipant, createChat } from "../services/chat/conversation.js";
import { buildClientMessagePayload, buildClientMessagePayloadsForInbox } from "../services/chat/message-dispatcher.js";
import { createAdminContext, createTestApp, seedHealthyAgentRuntime } from "./helpers.js";

let app: FastifyInstance;
let ctx: { memberId: string; clientId: string; humanAgentUuid: string };

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  ctx = await createAdminContext(app, { username: `disp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
});

const RAW = {
  id: "msg-1",
  chatId: "chat-1",
  senderId: "sender-1",
  format: "text",
  content: "hello",
  metadata: {},
  inReplyTo: null,
  source: null as string | null,
  createdAt: new Date().toISOString(),
};

describe("buildClientMessagePayload (Step 3)", () => {
  it("includes the current config version (initial = 1)", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-fresh-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const built = await buildClientMessagePayload(app.db, { kind: "agentId", agentId: agent.uuid }, RAW);
    expect(built.configVersion).toBe(1);
    expect(built.id).toBe(RAW.id);
  });

  it("reflects bumped config version after PATCH", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-bumped-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    await app.configService.update(agent.uuid, { expectedVersion: 1, payload: { model: "claude-opus-4-6" } }, "test");
    await app.configService.flush(agent.uuid);
    const built = await buildClientMessagePayload(app.db, { kind: "agentId", agentId: agent.uuid }, RAW);
    expect(built.configVersion).toBe(2);
  });

  it("resolves agentId from inboxId", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-inbox-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const built = await buildClientMessagePayload(app.db, { kind: "inboxId", inboxId: agent.inboxId }, RAW);
    expect(built.configVersion).toBe(1);
    expect(built.id).toBe(RAW.id);
  });

  it("batch variant returns the same version for all messages", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-batch-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const messages = Array.from({ length: 3 }, (_, i) => ({
      entryChatId: RAW.chatId,
      message: { ...RAW, id: `msg-${i}` },
    }));
    const built = await buildClientMessagePayloadsForInbox(app.db, agent.inboxId, messages);
    expect(built.map((b) => b.configVersion)).toEqual([1, 1, 1]);
  });

  it("normalises unknown source values to null", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-srcN-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: agent.uuid },
      { ...RAW, source: "totally-not-a-known-source" },
    );
    expect(built.source).toBeNull();
  });

  it("throws when inboxId has no owning agent", async () => {
    await expect(
      buildClientMessagePayload(app.db, { kind: "inboxId", inboxId: "inbox_does_not_exist" }, RAW),
    ).rejects.toThrow(/No agent owns inbox/);
  });
});

/**
 * v2: `chat_membership.mode` is decision-inert. The wire payload still
 * carries `recipientMode` for backwards compatibility with already-deployed
 * client runtimes, but the value is the constant `"mention_only"` for every
 * recipient and the dispatcher no longer reads `chat_membership.mode` to
 * decide it. See proposals/hub-chat-message-v2-simplify-mode.20260520.md §七.
 */
describe("buildClientMessagePayload — recipientMode (v2 constant)", () => {
  it("emits the constant 'mention_only' regardless of the agent / chat shape", async () => {
    const agent = await createAgent(app.db, {
      name: `rmode-stranger-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: agent.uuid },
      RAW,
      "unrelated-chat-id",
    );
    expect(built.recipientMode).toBe("mention_only");
  });

  it("agent↔agent two-speaker chat → 'mention_only' wire value", async () => {
    const a1 = await createAgent(app.db, {
      name: `rmode-dir1-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const a2 = await createAgent(app.db, {
      name: `rmode-dir2-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: a2.uuid },
      { ...RAW, chatId: chat.id },
      chat.id,
    );
    expect(built.recipientMode).toBe("mention_only");
  });

  it("human↔agent two-speaker chat → 'mention_only' wire value (no v1 'full' derivation)", async () => {
    const human = await getAgent(app.db, ctx.humanAgentUuid);
    if (!human) throw new Error("expected admin human mirror");
    const agent = await createAgent(app.db, {
      name: `rmode-agt-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await createChat(app.db, human.uuid, { type: "group", participantIds: [agent.uuid] });
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: agent.uuid },
      { ...RAW, chatId: chat.id },
      chat.id,
    );
    expect(built.recipientMode).toBe("mention_only");
  });

  it("3+ speaker group → every speaker gets the same constant", async () => {
    const a1 = await createAgent(app.db, {
      name: `rmode-a1-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const a2 = await createAgent(app.db, {
      name: `rmode-a2-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const a3 = await createAgent(app.db, {
      name: `rmode-a3-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    await addParticipant(app.db, chat.id, a1.uuid, { agentId: a3.uuid });

    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: a3.uuid },
      { ...RAW, chatId: chat.id },
      chat.id,
    );
    expect(built.recipientMode).toBe("mention_only");
  });

  it("batch variant emits the same constant wire value for every item", async () => {
    const a1 = await createAgent(app.db, {
      name: `batch-a1-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const a2 = await createAgent(app.db, {
      name: `batch-a2-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const group = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [a2.uuid],
    });

    const built = await buildClientMessagePayloadsForInbox(app.db, a1.inboxId, [
      {
        entryChatId: group.id,
        message: {
          ...RAW,
          id: `msg-a-${Date.now()}`,
          chatId: group.id,
          senderId: a2.uuid,
          content: "first",
        },
      },
      {
        entryChatId: group.id,
        message: {
          ...RAW,
          id: `msg-b-${Date.now()}`,
          chatId: group.id,
          senderId: a2.uuid,
          content: "second",
        },
      },
    ]);

    expect(built).toHaveLength(2);
    const first = built[0];
    const second = built[1];
    if (!first || !second) throw new Error("expected two payloads");
    expect(first.recipientMode).toBe("mention_only");
    expect(second.recipientMode).toBe("mention_only");
  });
});

/**
 * Rollout gate at the DB-row→wire boundary: a message carrying the
 * server-owned `teamSkillInvocation` marker may only reach a client whose
 * `sdk_version` resolves the marker fail-closed. The send-time menu gate
 * cannot cover messages already queued when the agent's client rolls
 * back, so the dispatcher re-checks the CURRENT route and swaps the
 * command content for an inert notice (text or image caption) — the
 * stored row, attachments, and metadata are never touched, and delivery
 * still settles normally instead of parking the FIFO behind a rollback.
 */
describe("buildClientMessagePayload — teamSkillInvocation rollout gate", () => {
  const MARKER = {
    version: 1,
    recipientAgentId: "00000000-0000-0000-0000-000000000001",
    resourceId: "00000000-0000-0000-0000-000000000002",
    requestedSlug: "review",
    configVersion: 1,
  };
  const marked = (content: unknown) => ({
    ...RAW,
    content,
    metadata: { mentions: ["sender-1"], teamSkillInvocation: MARKER },
  });

  async function setupAgent(suffix: string) {
    return createAgent(app.db, {
      name: `gate-${suffix}-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
  }

  async function connectWithVersion(agentUuid: string, sdkVersion: string | null) {
    await seedHealthyAgentRuntime(app, { agentUuid, clientId: ctx.clientId });
    await app.db.update(clients).set({ sdkVersion }).where(eq(clients.id, ctx.clientId));
  }

  it("passes the command through untouched while the connected client supports the marker", async () => {
    const agent = await setupAgent("ok");
    await connectWithVersion(agent.uuid, "0.5.22");
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: agent.uuid },
      marked("/review src/"),
    );
    expect(built.content).toBe("/review src/");
    expect(built.metadata?.teamSkillInvocation).toEqual(MARKER);
  });

  it("replaces the command with an inert notice after the client rolls back — DB row untouched", async () => {
    const agent = await setupAgent("rollback");
    await connectWithVersion(agent.uuid, "0.5.22");
    // Rollback: the bound client now runs a build without the marker reader.
    await connectWithVersion(agent.uuid, "0.5.21");
    const row = marked("/review src/");
    const built = await buildClientMessagePayload(app.db, { kind: "agentId", agentId: agent.uuid }, row);
    const text = built.content as string;
    expect(text).toContain("too old to run it safely");
    expect(text).not.toContain("/review");
    expect(text.startsWith("/")).toBe(false);
    // The stored row object is never mutated.
    expect(row.content).toBe("/review src/");
    expect(built.metadata?.teamSkillInvocation).toEqual(MARKER);
  });

  it("fails closed for an unknown / unbound / offline client route", async () => {
    const agent = await setupAgent("unbound");
    // No live route-consistent presence at all.
    const built = await buildClientMessagePayload(app.db, { kind: "agentId", agentId: agent.uuid }, marked("/review"));
    expect(built.content).toContain("too old to run it safely");
    expect(built.content).not.toContain("/review");
    // Unknown version strings fail closed too.
    await connectWithVersion(agent.uuid, "garbage");
    const garbage = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: agent.uuid },
      marked("/review"),
    );
    expect(garbage.content).toContain("too old to run it safely");
  });

  it("replaces an image caption while preserving the attachment refs", async () => {
    const agent = await setupAgent("caption");
    await connectWithVersion(agent.uuid, "0.5.21");
    const batch = {
      caption: "/review src/",
      attachments: [{ imageId: "img-1", mimeType: "image/png", filename: "shot.png", size: 3 }],
    };
    const built = await buildClientMessagePayload(app.db, { kind: "agentId", agentId: agent.uuid }, marked(batch));
    const content = built.content as { caption: string; attachments: unknown[] };
    expect(content.caption).toContain("too old to run it safely");
    expect(content.caption).not.toContain("/review");
    expect(content.attachments).toEqual(batch.attachments);
  });

  it("leaves unmarked local commands untouched for the same old client", async () => {
    const agent = await setupAgent("local");
    await connectWithVersion(agent.uuid, "0.5.21");
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: agent.uuid },
      { ...RAW, content: "/ship it", metadata: { mentions: ["sender-1"] } },
    );
    expect(built.content).toBe("/ship it");
  });

  it("applies the gate per item in the batch variant", async () => {
    const agent = await setupAgent("batch");
    await connectWithVersion(agent.uuid, "0.5.21");
    const built = await buildClientMessagePayloadsForInbox(app.db, agent.inboxId, [
      { entryChatId: RAW.chatId, message: { ...marked("/review"), id: "m-1" } },
      { entryChatId: RAW.chatId, message: { ...RAW, id: "m-2", content: "/ship" } },
    ]);
    expect(built[0]?.content).toContain("too old to run it safely");
    expect(built[0]?.content).not.toContain("/review");
    expect(built[1]?.content).toBe("/ship");
  });
});

describe("buildClientMessagePayloadsForInbox — route query only when a marker is present", () => {
  function countingDb(db: typeof app.db) {
    let selects = 0;
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") selects++;
        return Reflect.get(target, prop, receiver);
      },
    });
    return { db: proxy as unknown as typeof app.db, count: () => selects };
  }

  it("skips the route/sdk query entirely for an all-unmarked batch (hot path)", async () => {
    const agent = await createAgent(app.db, {
      name: `hotpath-unmarked-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const { db, count } = countingDb(app.db);
    await buildClientMessagePayloadsForInbox(db, agent.inboxId, [
      { entryChatId: RAW.chatId, message: { ...RAW, id: "u-1", content: "hello" } },
      {
        entryChatId: RAW.chatId,
        message: { ...RAW, id: "u-2", content: "/ship it", metadata: { mentions: ["sender-1"] } },
      },
    ]);
    // Only the inbox-owner resolve + the config-version query — no
    // agents/agent_presence/clients route join.
    expect(count()).toBe(2);
  });

  it("pays exactly one route query when the batch contains a marker", async () => {
    const agent = await createAgent(app.db, {
      name: `hotpath-marked-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const markedMessage = {
      ...RAW,
      id: "m-1",
      content: "/review",
      metadata: {
        teamSkillInvocation: {
          version: 1,
          recipientAgentId: "00000000-0000-0000-0000-000000000001",
          resourceId: "00000000-0000-0000-0000-000000000002",
          requestedSlug: "review",
          configVersion: 1,
        },
      },
    };
    const { db, count } = countingDb(app.db);
    await buildClientMessagePayloadsForInbox(db, agent.inboxId, [
      { entryChatId: RAW.chatId, message: markedMessage },
      { entryChatId: RAW.chatId, message: { ...RAW, id: "m-2", content: "plain" } },
    ]);
    expect(count()).toBe(3);
  });
});
