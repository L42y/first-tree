/**
 * HTTP-level tests for `DELETE /api/v1/chats/:chatId/participants/:agentId`
 * — the web-side removal surface. Chat details previously had no removal
 * action at all ("deferred alongside the missing backend routes for
 * member-side removal"); this is that route.
 *
 * Class C route — `docs/development/http-path-conventions.md` requires
 * multi-org / access coverage. The authorization matrix itself lives in
 * `participant-removal.test.ts`; this file pins the wire contract and the
 * access boundary, plus one case proving the route really does route
 * through the shared authorizer rather than re-implementing it.
 */

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("DELETE /chats/:chatId/participants/:agentId", () => {
  const getApp = useTestApp();

  async function ownedAgent(app: ReturnType<typeof getApp>, memberId: string, orgId: string, label: string) {
    return createAgent(app.db, {
      name: `route-${label}-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: `Route ${label}`,
      managerId: memberId,
      organizationId: orgId,
    });
  }

  function removeUrl(chatId: string, agentId: string) {
    return `/api/v1/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(agentId)}`;
  }

  it("removes a participant and returns 204", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "ok");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });

    const res = await app.inject({
      method: "DELETE",
      url: removeUrl(chatId, helper.uuid),
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(res.statusCode).toBe(204);
    const [row] = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, helper.uuid)));
    expect(row).toBeUndefined();
  });

  it("404s for a same-org caller with no access to the chat (anti-enumeration)", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const outsider = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "iso");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });

    const res = await app.inject({
      method: "DELETE",
      url: removeUrl(chatId, helper.uuid),
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });

    expect(res.statusCode).toBe(404);
    const [row] = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, helper.uuid)));
    expect(row).toBeDefined();
  });

  it("404s for a caller in a different organization (cross-org boundary)", async () => {
    const app = getApp();
    const caller = await createTestAdmin(app);

    const orgB = `org-rm-${crypto.randomUUID().slice(0, 6)}`;
    await app.db.insert(organizations).values({ id: orgB, name: orgB.slice(0, 30), displayName: "Org B" });
    const botUuid = crypto.randomUUID();
    await app.db.insert(agents).values({
      uuid: botUuid,
      name: `bot-rm-${crypto.randomUUID().slice(0, 6)}`,
      organizationId: orgB,
      type: "agent",
      displayName: "Bot B",
      inboxId: `inbox_${botUuid}`,
      // FK is unconstrained across orgs; mirrors the cross-org convention
      // used by the pin-route suite for building a side-org agent cheaply.
      managerId: caller.memberId,
    });
    const chatIdB = crypto.randomUUID();
    await app.db.insert(chats).values({ id: chatIdB, organizationId: orgB, type: "group" });
    await app.db
      .insert(chatMembership)
      .values({ chatId: chatIdB, agentId: botUuid, role: "member", accessMode: "speaker" });

    const res = await app.inject({
      method: "DELETE",
      url: removeUrl(chatIdB, botUuid),
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("applies the shared authorizer — a bystander speaker gets 403", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const bystander = await createTestAdmin(app);
    const victimOwner = await createTestAdmin(app);
    const victim = await ownedAgent(app, victimOwner.memberId, victimOwner.organizationId, "victim");
    const bystanderAgent = await ownedAgent(app, bystander.memberId, bystander.organizationId, "bystander");

    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [victim.uuid, bystanderAgent.uuid],
    });
    // The bystander speaks in the chat but owns neither it nor the target.
    await app.db
      .insert(chatMembership)
      .values({
        chatId,
        agentId: bystander.humanAgentUuid,
        role: "member",
        accessMode: "speaker",
        mode: "mention_only",
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [chatMembership.chatId, chatMembership.agentId],
        set: { accessMode: "speaker" },
      });

    const res = await app.inject({
      method: "DELETE",
      url: removeUrl(chatId, victim.uuid),
      headers: { authorization: `Bearer ${bystander.accessToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses removing yourself — that is workspace-leave", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const helper = await ownedAgent(app, owner.memberId, owner.organizationId, "selfroute");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [helper.uuid],
    });

    const res = await app.inject({
      method: "DELETE",
      url: removeUrl(chatId, owner.humanAgentUuid),
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(res.statusCode).toBe(400);
  });
});
