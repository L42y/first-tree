import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { clients } from "../db/schema/clients.js";
import { messages } from "../db/schema/messages.js";
import { resources } from "../db/schema/resources.js";
import { ConflictError } from "../errors.js";
import { resolveCanonicalTeamSkillInvocation } from "../services/agents/resources/catalog.js";
import { createChat } from "../services/chat/conversation.js";
import { pollInbox } from "../services/chat/inbox.js";
import { sendMessage } from "../services/chat/message.js";
import { uuidv7 } from "../uuid.js";
import { createTestAgent, seedHealthyAgentRuntime, useTestApp } from "./helpers.js";

/**
 * `skillPrecondition` is a transient, request-level guard for Team Skill
 * slash commands picked from the web composer menu; the
 * `metadata.teamSkillInvocation` marker it earns is the SERVER-OWNED,
 * persisted proof of Team intent. The message transaction:
 *
 *   1. locks the recipient's `agent_configs` row FOR UPDATE, so a
 *      concurrent config update either commits first (version mismatch →
 *      conflict) or blocks until after this commit (delivery then stamps
 *      the newer version and the Client settles a terminal notice) — there
 *      is no interleave that commits a v1-validated command as a
 *      marker-less v2 message;
 *   2. validates the recipient set and the locked config version;
 *   3. resolves the CANONICAL invocation identity through the trusted
 *      resources seam (effective row's own resourceId +
 *      `normalizeTeamSkillTargetSlug(payload.name)`), never from the
 *      request's untrusted fields;
 *   4. stamps the versioned marker only after all of the above.
 *
 * The precondition itself is never persisted; an inbound forged marker is
 * always stripped or overwritten.
 */
describe("sendMessage skillPrecondition → server-owned teamSkillInvocation marker", () => {
  const getApp = useTestApp();

  const RES_NAME = "Code Review"; // canonical slug: code-review
  const SLUG = "code-review";

  async function setup(uid: string) {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `sp-s-${uid}` });
    const { agent: peerA, clientId: peerAClientId } = await createTestAgent(app, { name: `sp-a-${uid}` });
    const { agent: peerB } = await createTestAgent(app, { name: `sp-b-${uid}` });
    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [peerA.uuid, peerB.uuid],
    });
    // Seed an enabled Team Skill for peerA: a team-scoped resource plus an
    // include binding, mirroring how replaceAgentResources projects one.
    const resourceId = uuidv7();
    await app.db.insert(resources).values({
      id: resourceId,
      organizationId: sender.organizationId,
      type: "skill",
      scope: "team",
      ownerAgentId: null,
      name: RES_NAME,
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: RES_NAME, description: "Review a change end to end.", body: "SKILL BODY", metadata: {} },
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: sender.organizationId,
      agentId: peerA.uuid,
      type: "skill",
      mode: "include",
      resourceId,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 0,
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    const [configRow] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, peerA.uuid));
    if (!configRow) throw new Error("expected an agent_configs row for the test agent");
    const validate = (precondition: { recipientAgentId: string; resourceId: string; requestedSlug: string }) =>
      resolveCanonicalTeamSkillInvocation(app.resourcesService, precondition);
    return { app, sender, peerA, peerAClientId, peerB, chat, resourceId, configVersion: configRow.version, validate };
  }

  async function messageCount(app: ReturnType<ReturnType<typeof useTestApp>>, chatId: string) {
    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
    return rows.length;
  }

  function validPrecondition(ctx: { peerA: { uuid: string }; resourceId: string; configVersion: number }) {
    return {
      recipientAgentId: ctx.peerA.uuid,
      expectedConfigVersion: ctx.configVersion,
      resourceId: ctx.resourceId,
      requestedSlug: SLUG,
    };
  }

  it("stamps the canonical versioned marker from the validated effective row", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, resourceId, configVersion, validate } = ctx;
    const result = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "web",
        format: "text",
        content: "/code-review src/",
        metadata: { mentions: [peerA.uuid] },
        purpose: "team-skill-invocation-v1",
        skillPrecondition: validPrecondition(ctx),
      },
      { validateTeamSkillInvocation: validate },
    );
    expect(result.message.id).toBeTruthy();
    expect(await messageCount(app, chat.id)).toBe(1);
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    // The transient precondition itself is never persisted…
    expect(stored?.metadata ?? {}).not.toHaveProperty("skillPrecondition");
    // …and the marker is EXACTLY the canonical identity from the effective
    // row — the same values a Client will require at resolve time.
    expect(stored?.metadata?.teamSkillInvocation).toEqual({
      version: 1,
      recipientAgentId: peerA.uuid,
      resourceId,
      requestedSlug: SLUG,
      configVersion,
    });
  });

  it("rejects a request slug that does not match the canonical effective-row slug", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, validate } = ctx;
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "/review src/",
          metadata: { mentions: [peerA.uuid] },
          purpose: "team-skill-invocation-v1",
          skillPrecondition: { ...validPrecondition(ctx), requestedSlug: "review" },
        },
        { validateTeamSkillInvocation: validate },
      ),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("rejects a resourceId that is not an enabled Team Skill of the recipient", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, validate } = ctx;
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "/code-review src/",
          metadata: { mentions: [peerA.uuid] },
          purpose: "team-skill-invocation-v1",
          skillPrecondition: { ...validPrecondition(ctx), resourceId: crypto.randomUUID() },
        },
        { validateTeamSkillInvocation: validate },
      ),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("rejects when the config version moved after selection, inserting nothing", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, configVersion, validate } = ctx;
    // Admin removed/renamed the Team Skill after the menu was opened: bump
    // the config version, as a real resources update would.
    await app.db
      .update(agentConfigs)
      .set({ version: configVersion + 1 })
      .where(eq(agentConfigs.agentId, peerA.uuid));
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "/code-review src/",
          metadata: { mentions: [peerA.uuid] },
          purpose: "team-skill-invocation-v1",
          skillPrecondition: validPrecondition(ctx),
        },
        { validateTeamSkillInvocation: validate },
      ),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("rejects when the routed recipients are not exactly the precondition agent", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, peerB, chat, validate } = ctx;
    for (const mentions of [[peerA.uuid, peerB.uuid], [peerB.uuid]]) {
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          {
            source: "web",
            format: "text",
            content: "/code-review src/",
            metadata: { mentions },
            purpose: "team-skill-invocation-v1",
            skillPrecondition: validPrecondition(ctx),
          },
          { validateTeamSkillInvocation: validate },
        ),
      ).rejects.toThrow(ConflictError);
    }
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("rejects a precondition on a send path without the trusted validation seam", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat } = ctx;
    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "api",
        format: "text",
        content: "/code-review src/",
        metadata: { mentions: [peerA.uuid] },
        purpose: "team-skill-invocation-v1",
        skillPrecondition: validPrecondition(ctx),
      }),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("never stamps a marker for a normalized-collision skill group", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, validate } = ctx;
    // A second Team Skill whose name normalizes to the same target makes
    // the whole group duplicate_skill_target_name unavailable.
    const collisionId = uuidv7();
    await app.db.insert(resources).values({
      id: collisionId,
      organizationId: sender.organizationId,
      type: "skill",
      scope: "team",
      ownerAgentId: null,
      name: "code_review",
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: "code_review", description: "d", body: "B", metadata: {} },
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: sender.organizationId,
      agentId: peerA.uuid,
      type: "skill",
      mode: "include",
      resourceId: collisionId,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 1,
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "/code-review src/",
          metadata: { mentions: [peerA.uuid] },
          purpose: "team-skill-invocation-v1",
          skillPrecondition: validPrecondition(ctx),
        },
        { validateTeamSkillInvocation: validate },
      ),
    ).rejects.toThrow(ConflictError);
    expect(await messageCount(app, chat.id)).toBe(0);
  });

  it("serializes a concurrent config update against the row lock: marker keeps the validated version", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, resourceId, configVersion, validate } = ctx;
    // Once the message transaction holds the agent_configs row lock, a
    // concurrent config update must BLOCK until after the commit. The
    // validator hook runs under the lock: it starts the UPDATE for real
    // (an async IIFE, not a lazy QueryPromise) and then proves — on an
    // independent connection, READ COMMITTED — that the UPDATE has not
    // committed while the lock is held (the row still reads v1).
    let concurrentUpdate: Promise<unknown> | null = null;
    const result = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "web",
        format: "text",
        content: "/code-review src/",
        metadata: { mentions: [peerA.uuid] },
        purpose: "team-skill-invocation-v1",
        skillPrecondition: validPrecondition(ctx),
      },
      {
        validateTeamSkillInvocation: async (precondition) => {
          concurrentUpdate = (async () => {
            await app.db
              .update(agentConfigs)
              .set({ version: configVersion + 1 })
              .where(eq(agentConfigs.agentId, peerA.uuid));
          })();
          // Deterministic serialization proof without any sleep: while
          // this transaction holds the row lock, the concurrent UPDATE
          // cannot have committed, so a fresh read still sees v1.
          const [during] = await app.db
            .select({ version: agentConfigs.version })
            .from(agentConfigs)
            .where(eq(agentConfigs.agentId, peerA.uuid));
          expect(during?.version).toBe(configVersion);
          return validate(precondition);
        },
      },
    );
    expect(result.message.id).toBeTruthy();
    await concurrentUpdate;
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    // The message was validated and stamped at v1…
    expect(stored?.metadata?.teamSkillInvocation).toEqual({
      version: 1,
      recipientAgentId: peerA.uuid,
      resourceId,
      requestedSlug: SLUG,
      configVersion,
    });
    // …and the blocked UPDATE completed after the commit, so the
    // delivery-time stamp will diverge from the marker — the Client's
    // terminal-notice path.
    const [after] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, peerA.uuid));
    expect(after?.version).toBe(configVersion + 1);
  });

  it("strips a client-supplied invocation marker when no valid precondition accompanies it", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat } = ctx;
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "web",
      format: "text",
      content: "/code-review src/",
      metadata: {
        mentions: [peerA.uuid],
        teamSkillInvocation: {
          version: 1,
          recipientAgentId: peerA.uuid,
          resourceId: uuidv7(),
          requestedSlug: SLUG,
          configVersion: 1,
        },
      },
    });
    expect(result.message.id).toBeTruthy();
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(stored?.metadata ?? {}).not.toHaveProperty("teamSkillInvocation");
  });

  it("overwrites a forged marker with the canonical one when the precondition passes", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat, resourceId, configVersion, validate } = ctx;
    const result = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "web",
        format: "text",
        content: "/code-review src/",
        metadata: {
          mentions: [peerA.uuid],
          teamSkillInvocation: {
            version: 1,
            recipientAgentId: peerA.uuid,
            resourceId: crypto.randomUUID(),
            requestedSlug: "forged",
            configVersion: 999,
          },
        },
        purpose: "team-skill-invocation-v1",
        skillPrecondition: validPrecondition(ctx),
      },
      { validateTeamSkillInvocation: validate },
    );
    expect(result.message.id).toBeTruthy();
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(stored?.metadata?.teamSkillInvocation).toEqual({
      version: 1,
      recipientAgentId: peerA.uuid,
      resourceId,
      requestedSlug: SLUG,
      configVersion,
    });
  });

  it("leaves sends without a precondition untouched (hand-typed runtime/local commands)", async () => {
    const ctx = await setup(crypto.randomUUID().slice(0, 6));
    const { app, sender, peerA, chat } = ctx;
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "web",
      format: "text",
      content: "/local-thing",
      metadata: { mentions: [peerA.uuid] },
    });
    expect(result.message.id).toBeTruthy();
    const [stored] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(stored?.metadata ?? {}).not.toHaveProperty("teamSkillInvocation");
  });
});

/**
 * Rollback safety for ALREADY-QUEUED marker messages, proven through the
 * production claim path: a marker message persisted and fanned out while
 * the client supports the marker, then the bound client downgrades before
 * the claim — `pollInbox` must deliver the inert notice on the wire while
 * the stored row keeps the original content and canonical marker.
 */
describe("queued marker message + client rollback before claim (production inbox path)", () => {
  const getApp = useTestApp();

  it("delivers an inert notice after a rollback, leaving the stored row untouched", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `rb-s-${uid}` });
    const { agent: peer, clientId } = await createTestAgent(app, { name: `rb-p-${uid}` });
    const chat = await createChat(app.db, sender.agent.uuid, { type: "group", participantIds: [peer.uuid] });
    const resourceId = uuidv7();
    await app.db.insert(resources).values({
      id: resourceId,
      organizationId: sender.organizationId,
      type: "skill",
      scope: "team",
      ownerAgentId: null,
      name: "Code Review",
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: "Code Review", description: "d", body: "B", metadata: {} },
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: sender.organizationId,
      agentId: peer.uuid,
      type: "skill",
      mode: "include",
      resourceId,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 0,
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    const [configRow] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, peer.uuid));
    if (!configRow) throw new Error("expected an agent_configs row for the test agent");

    // Connected client on a marker-reader build at enqueue time.
    await seedHealthyAgentRuntime(app, { agentUuid: peer.uuid, clientId });
    await app.db.update(clients).set({ sdkVersion: "0.5.22" }).where(eq(clients.id, clientId));

    const sent = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "web",
        format: "text",
        content: "/code-review src/",
        metadata: { mentions: [peer.uuid] },
        purpose: "team-skill-invocation-v1",
        skillPrecondition: {
          recipientAgentId: peer.uuid,
          expectedConfigVersion: configRow.version,
          resourceId,
          requestedSlug: "code-review",
        },
      },
      {
        validateTeamSkillInvocation: (precondition) =>
          resolveCanonicalTeamSkillInvocation(app.resourcesService, precondition),
      },
    );

    // Rollback BEFORE the claim: the bound client now runs a build without
    // the marker reader.
    await app.db.update(clients).set({ sdkVersion: "0.5.21" }).where(eq(clients.id, clientId));

    const delivered = await pollInbox(app.db, peer.inboxId, 5);
    const entry = delivered.find((e) => e.message.id === sent.message.id);
    if (!entry) throw new Error("expected the marked message in the claimed batch");
    const wireText = entry.message.content as string;
    expect(wireText).toContain("too old to run it safely");
    expect(wireText).not.toContain("/code-review");
    expect(wireText.startsWith("/")).toBe(false);
    // The marker itself still rides the wire payload (a NEW client that
    // reconnects later resolves it); only the command content was swapped.
    expect(entry.message.metadata?.teamSkillInvocation).toBeDefined();

    // The stored row keeps the original content and the canonical marker.
    const [stored] = await app.db.select().from(messages).where(eq(messages.id, sent.message.id));
    expect(stored?.content).toBe("/code-review src/");
    expect(stored?.metadata?.teamSkillInvocation).toEqual({
      version: 1,
      recipientAgentId: peer.uuid,
      resourceId,
      requestedSlug: "code-review",
      configVersion: configRow.version,
    });
  });
});

/**
 * Protocol pairing: the versioned purpose sentinel and the request-level
 * skillPrecondition must arrive together. The service layer enforces the
 * pair in BOTH directions so no caller can mint a marker from one half —
 * and an old Server (whose purpose enum knows only `agent-final-text`)
 * rejects the new Web payload at parse time instead of stripping an
 * unknown top-level field.
 */
describe("team-skill-invocation protocol pairing", () => {
  const getApp = useTestApp();

  async function setupPair(uid: string) {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `pp-s-${uid}` });
    const { agent: peer } = await createTestAgent(app, { name: `pp-p-${uid}` });
    const chat = await createChat(app.db, sender.agent.uuid, { type: "group", participantIds: [peer.uuid] });
    const [configRow] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, peer.uuid));
    if (!configRow) throw new Error("expected an agent_configs row for the test agent");
    return { app, sender, peer, chat, configVersion: configRow.version };
  }

  it("rejects a skillPrecondition without the sentinel purpose — zero insert", async () => {
    const { app, sender, peer, chat, configVersion } = await setupPair(crypto.randomUUID().slice(0, 6));
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "web",
          format: "text",
          content: "/code-review src/",
          metadata: { mentions: [peer.uuid] },
          skillPrecondition: {
            recipientAgentId: peer.uuid,
            expectedConfigVersion: configVersion,
            resourceId: uuidv7(),
            requestedSlug: "code-review",
          },
        },
        { validateTeamSkillInvocation: async () => null },
      ),
    ).rejects.toThrow(/must carry the team-skill-invocation-v1 purpose/);
    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chat.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects the sentinel purpose without a skillPrecondition — zero insert", async () => {
    const { app, sender, peer, chat } = await setupPair(crypto.randomUUID().slice(0, 6));
    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "web",
        format: "text",
        content: "/code-review src/",
        metadata: { mentions: [peer.uuid] },
        purpose: "team-skill-invocation-v1",
      }),
    ).rejects.toThrow(/must carry the team-skill-invocation-v1 purpose/);
    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chat.id));
    expect(rows).toHaveLength(0);
  });
});

/**
 * HTTP production path: the web message route enforces the same protocol
 * pair end to end — a paired Team send persists the canonical marker,
 * either half alone is a 400 with zero insert.
 */
describe("POST /chats/:chatId/messages — protocol pair over HTTP", () => {
  const getApp = useTestApp();

  async function setupHttp(uid: string) {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `http-s-${uid}` });
    const { agent: peer } = await createTestAgent(app, { name: `http-p-${uid}` });
    const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer.uuid],
    });
    if (chatRes.statusCode !== 201) throw new Error(`chat create failed: ${chatRes.statusCode}`);
    const chatId = chatRes.json().id as string;
    const resourceId = uuidv7();
    await app.db.insert(resources).values({
      id: resourceId,
      organizationId: sender.organizationId,
      type: "skill",
      scope: "team",
      ownerAgentId: null,
      name: "Code Review",
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: "Code Review", description: "d", body: "B", metadata: {} },
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: sender.organizationId,
      agentId: peer.uuid,
      type: "skill",
      mode: "include",
      resourceId,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 0,
      createdBy: sender.memberId,
      updatedBy: sender.memberId,
    });
    const [configRow] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, peer.uuid));
    if (!configRow) throw new Error("expected an agent_configs row for the test agent");
    return { app, sender, peer, chatId, resourceId, configVersion: configRow.version };
  }

  it("persists the canonical marker for a fully paired Team send", async () => {
    const { app, sender, peer, chatId, resourceId, configVersion } = await setupHttp(crypto.randomUUID().slice(0, 6));
    const res = await sender.request("POST", `/api/v1/chats/${chatId}/messages`, {
      format: "text",
      content: "/code-review src/",
      purpose: "team-skill-invocation-v1",
      metadata: { mentions: [peer.uuid] },
      skillPrecondition: {
        recipientAgentId: peer.uuid,
        expectedConfigVersion: configVersion,
        resourceId,
        requestedSlug: "code-review",
      },
    });
    expect(res.statusCode).toBe(201);
    const [stored] = await app.db
      .select()
      .from(messages)
      .where(eq(messages.id, res.json().id as string));
    expect(stored?.metadata?.teamSkillInvocation).toEqual({
      version: 1,
      recipientAgentId: peer.uuid,
      resourceId,
      requestedSlug: "code-review",
      configVersion,
    });
    // The sentinel itself is send-time-only: never persisted.
    expect(JSON.stringify(stored?.metadata ?? {})).not.toContain("team-skill-invocation-v1");
  });

  it("rejects either half alone with a 4xx and zero insert", async () => {
    const { app, sender, peer, chatId, resourceId, configVersion } = await setupHttp(crypto.randomUUID().slice(0, 6));
    const sentinelOnly = await sender.request("POST", `/api/v1/chats/${chatId}/messages`, {
      format: "text",
      content: "/code-review src/",
      purpose: "team-skill-invocation-v1",
      metadata: { mentions: [peer.uuid] },
    });
    expect(sentinelOnly.statusCode).toBeGreaterThanOrEqual(400);
    const preconditionOnly = await sender.request("POST", `/api/v1/chats/${chatId}/messages`, {
      format: "text",
      content: "/code-review src/",
      metadata: { mentions: [peer.uuid] },
      skillPrecondition: {
        recipientAgentId: peer.uuid,
        expectedConfigVersion: configVersion,
        resourceId,
        requestedSlug: "code-review",
      },
    });
    expect(preconditionOnly.statusCode).toBeGreaterThanOrEqual(400);
    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
    expect(rows).toHaveLength(0);
  });
});
