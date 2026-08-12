import { PROVISION_FIRST_TEAM_AGENT_ERROR_CODES } from "@first-tree/shared";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { connectDatabase } from "../db/connection.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { resources } from "../db/schema/resources.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agents/identity.js";
import { signTokensForUser } from "../services/auth/tokens.js";
import { createPersonalTeam } from "../services/team/membership.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, INVALID_BCRYPT_PLACEHOLDER, useTestApp } from "./helpers.js";

const PUBLISHER_ORG_ID = "first-team-agent-publisher-org-test";
const INTERNAL_URL = "/api/v1/internal/agent-templates";

type TestApp = FastifyInstance;

type TeamlessUser = { userId: string; username: string; displayName: string; accessToken: string };

/**
 * A user who is authenticated and belongs to nothing — the state solo signup
 * now leaves behind, and the only state this route's create path serves.
 */
async function createTeamlessUser(app: TestApp, displayName = "Solo Owner"): Promise<TeamlessUser> {
  const userId = uuidv7();
  const username = `solo-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(users).values({
    id: userId,
    username,
    passwordHash: INVALID_BCRYPT_PLACEHOLDER,
    displayName,
  });
  const tokens = await signTokensForUser(app.config.secrets.jwtSecret, userId, app.config.auth);
  return { userId, username, displayName, accessToken: tokens.accessToken };
}

const defaultTemplateIds = new WeakMap<TestApp, Promise<string>>();
const publishedDefaultTemplateIds = new Set<string>();

function defaultTemplateId(app: TestApp): Promise<string> {
  let pending = defaultTemplateIds.get(app);
  if (!pending) {
    pending = publishTemplate(app, `default-${crypto.randomUUID().slice(0, 8)}`).then((templateId) => {
      publishedDefaultTemplateIds.add(templateId);
      return templateId;
    });
    defaultTemplateIds.set(app, pending);
  }
  return pending;
}

async function provision(app: TestApp, user: { accessToken: string }, payload: Record<string, unknown> = {}) {
  const templateIds = "templateIds" in payload ? payload.templateIds : [await defaultTemplateId(app)];
  return app.inject({
    method: "POST",
    url: "/api/v1/me/team-agents",
    headers: { authorization: `Bearer ${user.accessToken}` },
    payload: { requestId: uuidv7(), ...payload, templateIds },
  });
}

async function publishTemplate(app: TestApp, slug: string): Promise<string> {
  const publisher = await createTestAdmin(app, { username: `pub-${crypto.randomUUID().slice(0, 8)}` });
  await app.db
    .insert(organizations)
    .values({ id: PUBLISHER_ORG_ID, name: "first-team-agent-publisher", displayName: "Publisher" })
    .onConflictDoNothing();
  const memberId = uuidv7();
  await app.db.transaction(async (tx) => {
    // Drizzle narrows the transaction type even though it exposes the same
    // query-builder surface `createAgent` uses in production transactions.
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `pub-human-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Publisher Human",
      managerId: memberId,
      organizationId: PUBLISHER_ORG_ID,
    });
    await tx.insert(members).values({
      id: memberId,
      userId: publisher.userId,
      organizationId: PUBLISHER_ORG_ID,
      agentId: human.uuid,
      role: "admin",
    });
  });

  const created = await app.inject({
    method: "POST",
    url: INTERNAL_URL,
    headers: { authorization: `Bearer ${publisher.accessToken}` },
    payload: {
      slug,
      name: slug,
      public: {
        tagline: "t",
        purpose: "p",
        targetUsers: "u",
        userValue: "v",
        instructionsSummary: "i",
        toolsAndSkillsSummary: "s",
      },
      components: [
        {
          key: "instructions",
          type: "prompt",
          name: "instructions prompt",
          payload: { body: "You triage incoming requests.", description: "core" },
        },
      ],
    },
  });
  expect(created.statusCode).toBe(201);
  const draft = created.json<{ id: string; updatedAt: string }>();
  const published = await app.inject({
    method: "POST",
    url: `${INTERNAL_URL}/${draft.id}/publish`,
    headers: { authorization: `Bearer ${publisher.accessToken}` },
    payload: { expectedUpdatedAt: draft.updatedAt },
  });
  expect(published.statusCode).toBe(200);
  return draft.id;
}

describe("POST /me/team-agents — first Team Agent provisioning", () => {
  const getApp = useTestApp({ agentTemplatePublisherOrgId: PUBLISHER_ORG_ID });

  afterAll(async () => {
    const app = getApp();
    for (const templateId of publishedDefaultTemplateIds) {
      await app.db.delete(agentTemplates).where(eq(agentTemplates.id, templateId));
    }
    publishedDefaultTemplateIds.clear();
  });

  it("creates the Team, Admin membership, human mirror and an unbound organization-visible Agent", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Atomic Owner");

    const reply = await provision(app, user, { name: "engineering-teammate", displayName: "Engineering Teammate" });

    expect(reply.statusCode).toBe(201);
    const body = reply.json<{
      organizationId: string;
      memberId: string;
      teamCreated: boolean;
      agentCreated: boolean;
      agent: { uuid: string; name: string; displayName: string; visibility: string; clientId: string | null };
    }>();
    expect(body.teamCreated).toBe(true);
    expect(body.agentCreated).toBe(true);
    expect(body.agent).toMatchObject({
      name: "engineering-teammate",
      displayName: "Engineering Teammate",
      // Organization-visible: the object the user just created IS the Team's
      // Agent, so no separate visibility choice is asked for.
      visibility: "organization",
      // Unbound — "needs setup" until a Runtime is picked later.
      clientId: null,
    });

    const [team] = await app.db.select().from(organizations).where(eq(organizations.id, body.organizationId));
    // Auto-generated name; onboarding never asks for one.
    expect(team?.displayName).toBe("Atomic Owner's team");

    const [membership] = await app.db.select().from(members).where(eq(members.userId, user.userId));
    expect(membership).toMatchObject({
      id: body.memberId,
      organizationId: body.organizationId,
      role: "admin",
      status: "active",
    });

    const [mirror] = await app.db
      .select()
      .from(agents)
      .where(eq(agents.uuid, membership?.agentId ?? ""));
    expect(mirror).toMatchObject({ type: "human", displayName: "Atomic Owner" });

    const [agent] = await app.db.select().from(agents).where(eq(agents.uuid, body.agent.uuid));
    expect(agent).toMatchObject({
      organizationId: body.organizationId,
      managerId: body.memberId,
      type: "agent",
      status: "active",
      source: "portal",
    });

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      onboarding: { step: "connect", completedAt: null },
      memberships: [
        {
          id: body.memberId,
          onboardingSuppressedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          onboardingSuppressedReason: "invitee_skip",
          onboardingCompletedAt: null,
        },
      ],
    });
  });

  it("adopts the selected Template into the Team it just created", async () => {
    const app = getApp();
    const templateId = await publishTemplate(app, `adopt-${crypto.randomUUID().slice(0, 6)}`);
    try {
      const user = await createTeamlessUser(app, "Template Owner");

      const reply = await provision(app, user, { name: "template-teammate", templateIds: [templateId] });

      expect(reply.statusCode).toBe(201);
      const body = reply.json<{ organizationId: string; agent: { uuid: string } }>();

      const [config] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, body.agent.uuid));
      expect(config?.templateIds).toEqual([templateId]);
      // Template components are imported into the brand-new Team's Resources
      // and bound to the Agent — all inside the same transaction that made the
      // Team.
      const teamResources = await app.db
        .select()
        .from(resources)
        .where(eq(resources.organizationId, body.organizationId));
      expect(teamResources.length).toBeGreaterThan(0);
      const bindings = await app.db
        .select()
        .from(agentResourceBindings)
        .where(eq(agentResourceBindings.agentId, body.agent.uuid));
      expect(bindings.length).toBeGreaterThan(0);
    } finally {
      // `agent_templates` is deliberately outside the per-test TRUNCATE list,
      // so a published row would outlive this file and land in the global
      // internal-list read that other suites assert on.
      await app.db.delete(agentTemplates).where(eq(agentTemplates.id, templateId));
    }
  });

  it("rolls the whole provision back when Template adoption fails", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Rollback Owner");

    const reply = await provision(app, user, {
      name: "rollback-teammate",
      templateIds: [crypto.randomUUID()],
    });

    expect(reply.statusCode).toBe(404);
    // All-or-nothing: no half-provisioned Team, membership, mirror, or Agent.
    expect(await app.db.select().from(members).where(eq(members.userId, user.userId))).toEqual([]);
    expect(await app.db.select().from(organizations).where(eq(organizations.name, user.username))).toEqual([]);
    expect(await app.db.select().from(agents).where(eq(agents.displayName, "Rollback Owner"))).toEqual([]);
  });

  it("converges a retried request on the same first Team and first Agent", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Retry Owner");

    const request = { requestId: uuidv7(), name: "retry-teammate", displayName: "Retry Teammate" };
    const first = await provision(app, user, request);
    const second = await provision(app, user, request);

    expect(first.statusCode).toBe(201);
    // 200, not 201: the retry resolved an existing Agent instead of creating one.
    expect(second.statusCode).toBe(200);
    const firstBody = first.json<{ organizationId: string; agent: { uuid: string } }>();
    const secondBody = second.json<{
      organizationId: string;
      teamCreated: boolean;
      agentCreated: boolean;
      agent: { uuid: string };
    }>();
    expect(secondBody.organizationId).toBe(firstBody.organizationId);
    expect(secondBody.agent.uuid).toBe(firstBody.agent.uuid);
    expect(secondBody.teamCreated).toBe(false);
    expect(secondBody.agentCreated).toBe(false);

    expect(await app.db.select().from(members).where(eq(members.userId, user.userId))).toHaveLength(1);
    const nonHuman = await app.db
      .select()
      .from(agents)
      .where(and(eq(agents.organizationId, firstBody.organizationId), ne(agents.type, "human")));
    expect(nonHuman).toHaveLength(1);
  });

  it("converges concurrent provisions on one Team and one Agent", async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const app = getApp();
    const user = await createTeamlessUser(app, "Concurrent Owner");
    const firstDb = connectDatabase(databaseUrl);
    const secondDb = connectDatabase(databaseUrl);
    try {
      const { provisionFirstTeamAgent } = await import("../services/team/first-team-agent.js");
      const requestId = uuidv7();
      const templateId = await defaultTemplateId(app);
      const results = await Promise.all(
        [firstDb, secondDb].map((db) =>
          provisionFirstTeamAgent(
            db,
            { userId: user.userId, requestId, name: "concurrent-teammate", templateIds: [templateId] },
            {
              attachmentBlobStore: app.attachmentBlobStore,
              idempotencySecret: app.config.secrets.jwtSecret,
              templatePublisherOrgId: PUBLISHER_ORG_ID,
            },
          ),
        ),
      );

      expect(results[0]?.organizationId).toBe(results[1]?.organizationId);
      expect(results[0]?.agent.uuid).toBe(results[1]?.agent.uuid);
      // Exactly one winner created each object.
      expect(results.map((r) => r.teamCreated).sort()).toEqual([false, true]);
      expect(results.map((r) => r.agentCreated).sort()).toEqual([false, true]);

      expect(await app.db.select().from(members).where(eq(members.userId, user.userId))).toHaveLength(1);
      const nonHuman = await app.db
        .select()
        .from(agents)
        .where(and(eq(agents.organizationId, results[0]?.organizationId ?? ""), ne(agents.type, "human")));
      expect(nonHuman).toHaveLength(1);
    } finally {
      await firstDb.end();
      await secondDb.end();
    }
  });

  it("rejects different concurrent Template intents instead of silently returning the winner", async () => {
    const app = getApp();
    const firstTemplateId = await publishTemplate(app, `concurrent-a-${crypto.randomUUID().slice(0, 6)}`);
    const secondTemplateId = await publishTemplate(app, `concurrent-b-${crypto.randomUUID().slice(0, 6)}`);
    try {
      const user = await createTeamlessUser(app, "Conflicting Owner");

      const replies = await Promise.all([
        provision(app, user, { name: "first-intent", templateIds: [firstTemplateId] }),
        provision(app, user, { name: "second-intent", templateIds: [secondTemplateId] }),
      ]);

      expect(replies.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
      const winner = replies.find((reply) => reply.statusCode === 201);
      const conflict = replies.find((reply) => reply.statusCode === 409);
      expect(conflict?.json()).toMatchObject({
        code: PROVISION_FIRST_TEAM_AGENT_ERROR_CODES.REQUEST_CONFLICT,
        error: expect.stringContaining("different first Team Agent"),
      });
      const winnerBody = winner?.json<{ agent: { uuid: string } }>();
      const [config] = await app.db
        .select({ templateIds: agentConfigs.templateIds })
        .from(agentConfigs)
        .where(eq(agentConfigs.agentId, winnerBody?.agent.uuid ?? ""));
      expect([[firstTemplateId], [secondTemplateId]]).toContainEqual(config?.templateIds);
      expect(await app.db.select().from(members).where(eq(members.userId, user.userId))).toHaveLength(1);
    } finally {
      await app.db.delete(agentTemplates).where(eq(agentTemplates.id, firstTemplateId));
      await app.db.delete(agentTemplates).where(eq(agentTemplates.id, secondTemplateId));
    }
  });

  it("allocates a mentionable Agent name when the Template slug matches the human mirror", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Name Collision Owner");
    const collidingName = `collision-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.update(users).set({ username: collidingName }).where(eq(users.id, user.userId));
    const requestId = uuidv7();

    const reply = await provision(app, user, { requestId, name: collidingName });

    expect(reply.statusCode).toBe(201);
    const body = reply.json<{ organizationId: string; agent: { uuid: string; name: string } }>();
    expect(body.agent.name).toMatch(new RegExp(`^${collidingName}-[a-f0-9]{8}$`));
    expect(body.agent.name).toHaveLength(collidingName.length + 9);

    const [membership] = await app.db.select().from(members).where(eq(members.userId, user.userId));
    const [mirror] = await app.db
      .select()
      .from(agents)
      .where(eq(agents.uuid, membership?.agentId ?? ""));
    expect(mirror?.name).toBe(collidingName);
    expect(mirror?.organizationId).toBe(body.organizationId);

    // Exact retries resolve the same immutable handle instead of treating the
    // server-assigned suffix as a different request payload.
    const retry = await provision(app, user, { requestId, name: collidingName });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      agentCreated: false,
      agent: { uuid: body.agent.uuid, name: body.agent.name },
    });

    const changedIntent = await provision(app, user, { requestId, name: body.agent.name });
    expect(changedIntent.statusCode).toBe(409);
  });

  it("keeps exact retry recognition independent of mutable Agent state", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Mutable Retry Owner");
    const request = { requestId: uuidv7(), name: "mutable-retry", displayName: "Original display" };
    const first = await provision(app, user, request);
    expect(first.statusCode).toBe(201);
    const body = first.json<{ agent: { uuid: string } }>();

    await app.db.update(agents).set({ displayName: "Changed later" }).where(eq(agents.uuid, body.agent.uuid));

    const retry = await provision(app, user, request);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      agentCreated: false,
      agent: { uuid: body.agent.uuid, displayName: "Changed later" },
    });
  });

  it("allocates a mentionable fallback when the caller omits the Agent name", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Nameless Owner");

    const reply = await provision(app, user, { requestId: uuidv7() });

    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({ agent: { name: "team-agent", displayName: "team-agent" } });
  });

  it("refuses Agent creation for an invited member because existing-Team creation is org-scoped", async () => {
    const app = getApp();
    const host = await createTeamlessUser(app, "Host Owner");
    const hostTeam = await createPersonalTeam(app.db, {
      userId: host.userId,
      username: host.username,
      teamDisplayName: "Host Owner's team",
      userDisplayName: "Host Owner",
    });
    const invitee = await createTeamlessUser(app, "Invited Member");
    const { ensureMembership } = await import("../services/team/membership.js");
    await ensureMembership(app.db, {
      userId: invitee.userId,
      organizationId: hostTeam.organizationId,
      role: "member",
      displayName: invitee.displayName,
      username: invitee.username,
    });

    const reply = await provision(app, invitee, { name: "invitee-teammate" });

    expect(reply.statusCode).toBe(409);
    // One membership only — the invited member never gets a personal Team.
    expect(await app.db.select().from(members).where(eq(members.userId, invitee.userId))).toHaveLength(1);
    const nonHuman = await app.db
      .select()
      .from(agents)
      .where(and(eq(agents.organizationId, hostTeam.organizationId), ne(agents.type, "human")));
    expect(nonHuman).toEqual([]);
  });

  it("does not mistake a matching existing-Team Agent for a first-Team retry", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Returning Owner");
    const team = await createPersonalTeam(app.db, {
      userId: user.userId,
      username: user.username,
      teamDisplayName: "Returning Owner's team",
      userDisplayName: "Returning Owner",
    });
    await createAgent(app.db, {
      name: "matching-teammate",
      displayName: "Matching Teammate",
      type: "agent",
      source: "portal",
      visibility: "organization",
      managerId: team.memberId,
      organizationId: team.organizationId,
    });

    const reply = await provision(app, user, {
      requestId: uuidv7(),
      name: "matching-teammate",
      displayName: "Matching Teammate",
    });

    expect(reply.statusCode).toBe(409);
  });

  it("refuses Agent creation for a multi-Team user because existing-Team creation is org-scoped", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Multi Owner");
    const older = await createPersonalTeam(app.db, {
      userId: user.userId,
      username: `${user.username}-older`,
      teamDisplayName: "Older team",
      userDisplayName: "Multi Owner",
    });
    const newer = await createPersonalTeam(app.db, {
      userId: user.userId,
      username: `${user.username}-newer`,
      teamDisplayName: "Newer team",
      userDisplayName: "Multi Owner",
    });

    const implicit = await provision(app, user, { name: "current-team-teammate" });
    expect(implicit.statusCode).toBe(409);

    const explicit = await provision(app, user, {
      organizationId: older.organizationId,
      name: "older-team-teammate",
    });
    expect(explicit.statusCode).toBe(400);

    expect(await app.db.select().from(members).where(eq(members.userId, user.userId))).toHaveLength(2);
    const nonHuman = await app.db.select().from(agents).where(ne(agents.type, "human"));
    expect(nonHuman).toEqual([]);
    expect(newer.organizationId).not.toBe(older.organizationId);
  });

  it("rejects organizationId because the user-scoped contract cannot hide Team scope in the body", async () => {
    const app = getApp();
    const outsider = await createTeamlessUser(app, "Outsider");
    const stranger = await createTeamlessUser(app, "Stranger");
    const strangerTeam = await createPersonalTeam(app.db, {
      userId: stranger.userId,
      username: stranger.username,
      teamDisplayName: "Stranger's team",
      userDisplayName: "Stranger",
    });

    const reply = await provision(app, outsider, {
      organizationId: strangerTeam.organizationId,
      name: "intruder",
    });

    expect(reply.statusCode).toBe(400);
    // Nothing is created anywhere — not in the stranger's Team, and not a
    // consolation personal Team for the caller.
    const strangerAgents = await app.db
      .select()
      .from(agents)
      .where(and(eq(agents.organizationId, strangerTeam.organizationId), ne(agents.type, "human")));
    expect(strangerAgents).toEqual([]);
    expect(await app.db.select().from(members).where(eq(members.userId, outsider.userId))).toEqual([]);
  });

  it("requires exactly one selected Template before creating the first Team", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Template Required Owner");

    for (const templateIds of [undefined, [], [uuidv7(), uuidv7()]]) {
      const reply = await app.inject({
        method: "POST",
        url: "/api/v1/me/team-agents",
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: {
          requestId: uuidv7(),
          name: "template-required",
          ...(templateIds === undefined ? {} : { templateIds }),
        },
      });
      expect(reply.statusCode).toBe(400);
    }

    expect(await app.db.select().from(members).where(eq(members.userId, user.userId))).toEqual([]);
  });

  it("disambiguates the Team slug when two users provision under the same name", async () => {
    const app = getApp();
    const login = `duplicate-${crypto.randomUUID().slice(0, 6)}`;
    const first = await createTeamlessUser(app, "Duplicate One");
    const second = await createTeamlessUser(app, "Duplicate Two");
    // Usernames are unique, but the Team slug is a sanitized derivation of
    // them — so two distinct users can still contend for one slug.
    await app.db.update(users).set({ username: login }).where(eq(users.id, first.userId));
    await app.db
      .update(users)
      .set({ username: `${login}.` })
      .where(eq(users.id, second.userId));

    const firstReply = await provision(app, first, { name: "dup-one" });
    const secondReply = await provision(app, second, { name: "dup-two" });

    expect(firstReply.statusCode).toBe(201);
    expect(secondReply.statusCode).toBe(201);
    const firstOrgId = firstReply.json<{ organizationId: string }>().organizationId;
    const secondOrgId = secondReply.json<{ organizationId: string }>().organizationId;
    expect(secondOrgId).not.toBe(firstOrgId);

    const [firstTeam] = await app.db.select().from(organizations).where(eq(organizations.id, firstOrgId));
    const [secondTeam] = await app.db.select().from(organizations).where(eq(organizations.id, secondOrgId));
    // First claims the bare slug; the second gets a 4-char hex disambiguator.
    expect(firstTeam?.name).toBe(login);
    expect(secondTeam?.name).toMatch(new RegExp(`^${login}-[0-9a-f]{4}$`));
  });

  it("rejects an unauthenticated caller", async () => {
    const app = getApp();
    const reply = await app.inject({ method: "POST", url: "/api/v1/me/team-agents", payload: { name: "anon" } });
    expect(reply.statusCode).toBe(401);
  });
});

describe("POST /me/team-agents on an invitation-only deployment", () => {
  const getApp = useTestApp({ allowedOrganizationId: "first-team-agent-allowed-org" });

  it("refuses to mint a Team for a user who has not redeemed an invite", async () => {
    const app = getApp();
    const user = await createTeamlessUser(app, "Uninvited");

    // Authorization rejects before adoption, so the Template only needs to be
    // contract-valid; invitation-only mode intentionally blocks publishing a
    // fixture through the same Team-less account path.
    const reply = await provision(app, user, { name: "uninvited-teammate", templateIds: [uuidv7()] });

    expect(reply.statusCode).toBe(403);
    expect(await app.db.select().from(members).where(eq(members.userId, user.userId))).toEqual([]);
  });
});
