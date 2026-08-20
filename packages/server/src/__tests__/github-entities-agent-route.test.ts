import { generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agents } from "../db/schema/agents.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../services/scm/github/app-installations.js";
import { createTestAgent, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

const { privateKey: githubAppPrivateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/**
 * Class D wiring for `first-tree github follow|unfollow|following`:
 * `/api/v1/agent/chats/:chatId/github-entities`. The follow business logic
 * lives in `github-entity-follow.test.ts`; this file locks the route layer —
 * participant gating, (human, delegate) pair resolution, and the
 * idempotent-unfollow HTTP contract.
 */
describe("agent github-entities routes", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem });

  async function seedOrgAgent(app: App, orgId: string, memberId: string): Promise<string> {
    const uuid = randomUUID();
    await app.db.insert(agents).values({
      uuid,
      name: `agent-${uuid.slice(0, 8)}`,
      organizationId: orgId,
      type: "agent",
      displayName: "agent",
      inboxId: `inbox_${uuid}`,
      managerId: memberId,
      status: "active",
    });
    return uuid;
  }

  async function createChatWith(a: Awaited<ReturnType<typeof createTestAgent>>, participantIds: string[]) {
    const res = await a.request("POST", "/api/v1/agent/chats", { type: "group", participantIds });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function seedInstallation(app: App, organizationId: string): Promise<void> {
    const githubAccountId = Math.floor(Math.random() * 1_000_000_000) + 1;
    const installation = await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: Math.floor(Math.random() * 1_000_000) + 1,
        accountType: "Organization",
        accountLogin: `acme-${githubAccountId}`,
        accountGithubId: githubAccountId,
        permissions: { issues: "read", pull_requests: "read" },
        events: ["pull_request", "issues"],
        suspendedAt: null,
      },
    });
    await bindInstallationToOrg(app.db, installation.installationId, organizationId);
  }

  function githubFollowFetcher(input: string | URL | Request): Promise<Response> {
    const url = String(input).toLowerCase();
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    if (url.includes("/access_tokens")) {
      return json(
        {
          token: "ghs_test_token",
          expires_at: "2099-01-01T00:00:00Z",
          permissions: { issues: "read", pull_requests: "read" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (url.includes("/repos/acme/api/issues/42")) {
      return json({
        number: 42,
        state: "open",
        title: "Watcher follow",
        html_url: "https://github.com/Acme/Api/pull/42",
        pull_request: { merged_at: null },
        draft: false,
      });
    }
    if (url.includes("/repos/acme/api/pulls/42")) {
      return json({
        number: 42,
        state: "open",
        title: "Watcher follow",
        html_url: "https://github.com/Acme/Api/pull/42",
        merged: false,
        draft: false,
      });
    }
    if (url.includes("/repos/acme/api")) return json({ full_name: "Acme/Api" });
    return json({ message: "Not Found" }, 404);
  }

  it("follow without an App installation is 422 with operator guidance", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: `gh-a-${randomUUID().slice(0, 6)}` });
    const human = a.humanAgentUuid;
    const chatId = await createChatWith(a, [human]);

    const res = await a.request("POST", `/api/v1/agent/chats/${chatId}/github-entities`, {
      entity: "acme/api#42",
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain("GitHub App");
  });

  it("rejects commit references at the agent API boundary", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: `gh-commit-${randomUUID().slice(0, 6)}` });
    const chatId = await createChatWith(a, [a.humanAgentUuid]);

    const res = await a.request("POST", `/api/v1/agent/chats/${chatId}/github-entities`, {
      entity: "https://github.com/acme/api/commit/3f2a91c0",
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Commit references are not supported");
    expect(await app.db.select().from(githubEntityChatMappings)).toHaveLength(0);
  });

  it("follow in an agents-only chat still resolves a pair via the supervising human watcher", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: `gh-b-${randomUUID().slice(0, 6)}` });
    const peerAgent = await seedOrgAgent(app, a.organizationId, a.memberId);
    const chatId = await createChatWith(a, [peerAgent]);
    await seedInstallation(app, a.organizationId);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(githubFollowFetcher);

    try {
      const res = await a.request("POST", `/api/v1/agent/chats/${chatId}/github-entities`, {
        entity: "acme/api#42",
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ status: "created", entity: { entityKey: "Acme/Api#42" } });
      expect(
        await app.db.select().from(githubEntityChatMappings).where(eq(githubEntityChatMappings.chatId, chatId)),
      ).toEqual([
        expect.objectContaining({
          humanAgentId: a.humanAgentUuid,
          delegateAgentId: a.agent.uuid,
          boundVia: "agent_declared",
        }),
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("a non-participant is rejected", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: `gh-d-${randomUUID().slice(0, 6)}` });
    const human = a.humanAgentUuid;
    const chatId = await createChatWith(a, [human]);

    const stranger = await createTestAgent(app, { name: `gh-e-${randomUUID().slice(0, 6)}` });
    const res = await stranger.request("POST", `/api/v1/agent/chats/${chatId}/github-entities`, {
      entity: "acme/api#42",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(403);
  });

  it("following lists the chat's wired entities; unfollow is idempotent over HTTP", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: `gh-f-${randomUUID().slice(0, 6)}` });
    const human = a.humanAgentUuid;
    const chatId = await createChatWith(a, [human]);

    await app.db.insert(githubEntityChatMappings).values({
      organizationId: a.organizationId,
      humanAgentId: human,
      delegateAgentId: a.agent.uuid,
      entityType: "pull_request",
      entityKey: "Acme/Api#42",
      chatId,
      boundVia: "agent_declared",
    });

    const list = await a.request("GET", `/api/v1/agent/chats/${chatId}/github-entities`);
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<{ entityKey: string; boundVia: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ entityKey: "Acme/Api#42", boundVia: "agent_declared" });

    const del = await a.request(
      "DELETE",
      `/api/v1/agent/chats/${chatId}/github-entities?entity=${encodeURIComponent("acme/api#42")}`,
    );
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ removed: 1 });

    const again = await a.request(
      "DELETE",
      `/api/v1/agent/chats/${chatId}/github-entities?entity=${encodeURIComponent("acme/api#42")}`,
    );
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ removed: 0 });
  });
});
