import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Web Class-C DELETE /chats/:chatId/participants/:agentId — same membership
 * mutation as the agent-JWT route, gated by the caller's human speaker row.
 */
describe("DELETE /api/v1/chats/:chatId/participants/:agentId", () => {
  const getApp = useTestApp();

  async function createSpeakerChat() {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `rm-peer-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Remove Peer",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [peer.uuid],
    });
    return { app, alice, peer, chatId };
  }

  it("removes an agent speaker (204) and drops them from the roster", async () => {
    const { app, alice, peer, chatId } = await createSpeakerChat();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(peer.uuid)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const participants = detail.json<{ participants: Array<{ agentId: string }> }>().participants;
    expect(participants.map((p) => p.agentId)).toEqual([alice.humanAgentUuid]);
  });

  it("removes a human speaker (204) and drops them from the roster", async () => {
    const { app, alice, peer, chatId } = await createSpeakerChat();
    const bob = await createTestAdmin(app);
    await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/participants`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { participantIds: [bob.humanAgentUuid] },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(bob.humanAgentUuid)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    const participants = detail.json<{ participants: Array<{ agentId: string }> }>().participants;
    expect(participants.map((p) => p.agentId).sort()).toEqual([alice.humanAgentUuid, peer.uuid].sort());
  });

  it("rejects self-removal with 400", async () => {
    const { app, alice, chatId } = await createSpeakerChat();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(alice.humanAgentUuid)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-member target with 404", async () => {
    const { app, alice, chatId } = await createSpeakerChat();
    const outsider = await createTestAdmin(app);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(outsider.humanAgentUuid)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects trial chat removals with 403", async () => {
    const { app, alice, peer, chatId } = await createSpeakerChat();
    await app.db
      .update(chats)
      .set({
        metadata: {
          landingCampaignTrial: {
            campaign: "production-scan",
            agentId: peer.uuid,
            skillSetId: "production-scan",
            skillSetVersion: "test",
            repo: { url: "https://github.com/acme/backend", canonicalKey: "github.com/acme/backend" },
            state: "running",
            inputLocked: false,
          },
        },
      })
      .where(eq(chats.id, chatId));

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(peer.uuid)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a watcher / non-speaker caller with 403", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);
    const bobAgent = await createAgent(app.db, {
      name: `rm-bob-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Bob Agent",
      managerId: bob.memberId,
      organizationId: bob.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [bobAgent.uuid],
    });

    // Bob is auto-watcher (manages a speaker) but not a speaker.
    const bobMembership = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, bob.humanAgentUuid)));
    expect(bobMembership).toEqual([{ accessMode: "watcher" }]);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(bobAgent.uuid)}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("recomputes watchers after removing the anchoring agent speaker", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);
    const bobAgent = await createAgent(app.db, {
      name: `rm-anchor-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Anchor Agent",
      managerId: bob.memberId,
      organizationId: bob.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [bobAgent.uuid],
    });

    const before = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, bob.humanAgentUuid)));
    expect(before).toEqual([{ accessMode: "watcher" }]);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(bobAgent.uuid)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    const after = await app.db
      .select()
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, bob.humanAgentUuid)));
    expect(after).toHaveLength(0);
  });
});
