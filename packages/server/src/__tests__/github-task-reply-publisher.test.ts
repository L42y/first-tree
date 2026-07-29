import { generateKeyPairSync, randomUUID } from "node:crypto";
import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { bindAgentRuntimeSession } from "../services/agent-runtime-session.js";
import { createChat } from "../services/chat.js";
import { upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { submitGithubTaskReply } from "../services/github-task-reply-publisher.js";
import { sendMessage } from "../services/message.js";
import { putOrgSetting } from "../services/org-settings.js";
import { putTeamAgentAssignment } from "../services/team-agent-settings.js";
import { createAdminContext, seedHealthyAgentRuntime, useTestApp } from "./helpers.js";

const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("GitHub App task reply publisher", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem: privateKeyPem, runtimeHttpTokenEnforcement: false });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes one App-authored Issue comment, returns it idempotently, and rejects a changed payload", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher(fixture.runId);
    const input = publishInput(fixture, fetcher, "Completed the requested work.\n");

    const first = await submitGithubTaskReply(input);
    const second = await submitGithubTaskReply(input);

    expect(second).toEqual(first);
    expect(first).toEqual({
      commentId: 901,
      commentUrl: "https://github.com/owner/repo/issues/42#issuecomment-901",
      appActor: "test-app-slug[bot]",
    });
    const posts = githubCommentPosts(fetcher);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({
      body: `Completed the requested work.\n\n<!-- first-tree-github-task-reply-run:${fixture.runId} -->`,
    });
    await expect(
      submitGithubTaskReply({ ...input, request: { body: "A different terminal result." } }),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_PAYLOAD_MISMATCH" });

    const [message] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(message?.metadata.githubTaskReplySubmission).toMatchObject({
      state: "submitted",
      publisherAgentUuid: fixture.agent.uuid,
      publisherClientId: fixture.admin.clientId,
      commentId: 901,
    });
  });

  it("publishes a pull-request conversation comment with only pull-request write authority", async () => {
    const fixture = await createRunFixture(getApp(), { entityType: "pull_request" });
    const fetcher = successfulGithubFetcher(fixture.runId, "pull_requests");
    await expect(submitGithubTaskReply(publishInput(fixture, fetcher))).resolves.toMatchObject({
      commentId: 901,
      appActor: "test-app-slug[bot]",
    });
    const tokenRequest = fetcher.mock.calls.find(([url]) => String(url).endsWith("/access_tokens"));
    expect(JSON.parse(String(tokenRequest?.[1]?.body))).toEqual({
      repositories: ["repo"],
      permissions: { metadata: "read", pull_requests: "write" },
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
  });

  it("lets the Context Reviewer use only the ordinary comment publisher for a bound-repo App task", async () => {
    const fixture = await createRunFixture(getApp(), { entityType: "pull_request", contextRepository: true });
    const fetcher = successfulGithubFetcher(fixture.runId, "pull_requests");
    await expect(
      submitGithubTaskReply(publishInput(fixture, fetcher, "Ordinary task outcome.")),
    ).resolves.toMatchObject({
      commentId: 901,
    });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/reviews"))).toBe(false);
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
  });

  it("requires the exact Agent, active runtime proof, and original chat route", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher(fixture.runId);
    await expect(
      submitGithubTaskReply({
        ...publishInput(fixture, fetcher),
        callerAgentUuid: "another-agent",
      }),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN" });
    await expect(
      submitGithubTaskReply({
        ...publishInput(fixture, fetcher),
        callerRuntimeSessionToken: "invalid",
      }),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN" });
    await expect(
      submitGithubTaskReply({
        ...publishInput(fixture, fetcher),
        chatId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_NOT_FOUND" });
    expect(fetcher).not.toHaveBeenCalled();

    const missingProof = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${fixture.chatId}/github-task-runs/${fixture.runId}/reply`,
      headers: {
        authorization: `Bearer ${fixture.admin.accessToken}`,
        [AGENT_SELECTOR_HEADER]: fixture.agent.uuid,
      },
      payload: { body: "Done" },
    });
    expect(missingProof.statusCode).toBe(403);
    expect(missingProof.json()).toMatchObject({ code: "GITHUB_TASK_REPLY_RUNTIME_SESSION_REQUIRED" });

    vi.stubGlobal("fetch", successfulGithubFetcher(fixture.runId));
    const accepted = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${fixture.chatId}/github-task-runs/${fixture.runId}/reply`,
      headers: {
        authorization: `Bearer ${fixture.admin.accessToken}`,
        [AGENT_SELECTOR_HEADER]: fixture.agent.uuid,
        [AGENT_RUNTIME_SESSION_HEADER]: fixture.runtimeToken,
      },
      payload: { body: "Done" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ appActor: "test-app-slug[bot]" });
  });

  it("revokes publication when the selected Team Agent or installation permission changes", async () => {
    const fixture = await createRunFixture(getApp());
    const replacement = await createAgent(fixture.app.db, {
      name: `replacement-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Replacement",
      managerId: fixture.admin.memberId,
      clientId: fixture.admin.clientId,
    });
    await seedHealthyAgentRuntime(fixture.app, {
      agentUuid: replacement.uuid,
      clientId: fixture.admin.clientId,
    });
    await putTeamAgentAssignment(fixture.app.db, fixture.admin.organizationId, replacement.uuid, {
      updatedBy: fixture.admin.userId,
      appSlug: "test-app-slug",
    });
    await expect(
      submitGithubTaskReply(publishInput(fixture, successfulGithubFetcher(fixture.runId))),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN" });

    await putTeamAgentAssignment(fixture.app.db, fixture.admin.organizationId, fixture.agent.uuid, {
      updatedBy: fixture.admin.userId,
      appSlug: "test-app-slug",
    });
    await fixture.app.db
      .update(githubAppInstallations)
      .set({ permissions: { metadata: "read", issues: "read", pull_requests: "write" } })
      .where(eq(githubAppInstallations.hubOrganizationId, fixture.admin.organizationId));
    await expect(
      submitGithubTaskReply(publishInput(fixture, successfulGithubFetcher(fixture.runId))),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED" });
  });

  it("rejects App mentions and reserved hidden markers before GitHub comment mutation", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher(fixture.runId);
    await expect(
      submitGithubTaskReply(publishInput(fixture, fetcher, "Thanks @test-app-slug, done.")),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_INVALID_REQUEST" });
    await expect(
      submitGithubTaskReply(
        publishInput(fixture, fetcher, `Done\n<!-- first-tree-github-task-reply-run:${fixture.runId} -->`),
      ),
    ).rejects.toThrow(/reserved GitHub task reply run marker/);
    expect(githubCommentPosts(fetcher)).toHaveLength(0);
  });

  it("reconciles an unknown App write by actor, marker, and exact body without blind replay", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = unknownThenReconciledGithubFetcher(fixture.runId);
    const input = publishInput(fixture, fetcher, "Deferred outcome  \n");

    await expect(submitGithubTaskReply(input)).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN" });
    await expect(submitGithubTaskReply(input)).resolves.toMatchObject({
      commentId: 902,
      appActor: "test-app-slug[bot]",
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
  });

  it("does not allow an ordinary message sender to author reserved GitHub task run provenance", async () => {
    const fixture = await createRunFixture(getApp());
    await expect(
      sendMessage(fixture.app.db, fixture.chatId, fixture.admin.humanAgentUuid, {
        source: "api",
        format: "text",
        content: "spoof",
        metadata: {
          mentions: [fixture.agent.uuid],
          teamAgentTask: { agentUuid: fixture.agent.uuid, runId: "spoof" },
          githubTaskRun: true,
          githubTaskRunId: "spoof",
          githubTaskAgentUuid: fixture.agent.uuid,
        },
      }),
    ).rejects.toThrow(/reserved for server-authored GitHub task reply runs/);
  });
});

async function createRunFixture(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  options: { entityType?: "issue" | "pull_request"; contextRepository?: boolean } = {},
) {
  const admin = await createAdminContext(app);
  const agent = await createAgent(app.db, {
    name: `team-agent-${randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: "Team Agent",
    managerId: admin.memberId,
    clientId: admin.clientId,
  });
  await seedHealthyAgentRuntime(app, { agentUuid: agent.uuid, clientId: admin.clientId });
  const runtimeToken = await bindAgentRuntimeSession(app.db, agent.uuid, admin.clientId);
  await upsertInstallationFromMetadata(app.db, {
    installation: {
      id: Number(`8${Math.floor(Math.random() * 1_000_000)}`),
      accountType: "Organization",
      accountLogin: "owner",
      accountGithubId: Math.floor(Math.random() * 1_000_000_000),
      permissions: { metadata: "read", issues: "write", pull_requests: "write" },
      events: ["issues", "issue_comment", "pull_request"],
      suspendedAt: null,
    },
    hubOrganizationId: admin.organizationId,
  });
  if (options.contextRepository) {
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { provider: "github", repo: "https://github.com/owner/repo.git", branch: "main" },
      { updatedBy: admin.userId },
    );
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: agent.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );
  } else {
    await putTeamAgentAssignment(app.db, admin.organizationId, agent.uuid, {
      updatedBy: admin.userId,
      appSlug: "test-app-slug",
    });
  }
  const chat = await createChat(app.db, admin.humanAgentUuid, {
    type: "group",
    participantIds: [agent.uuid],
  });
  const runId = randomUUID();
  const entityType = options.entityType ?? "issue";
  const entityUrl = `https://github.com/owner/repo/${entityType === "issue" ? "issues" : "pull"}/42`;
  const { message } = await sendMessage(
    app.db,
    chat.id,
    admin.humanAgentUuid,
    {
      source: "github",
      format: "card",
      content: {
        type: "github_event",
        reason: "mentioned",
        event: entityType === "issue" ? "issues" : "pull_request",
        action: "opened",
        kind: "commented",
        repository: "owner/repo",
        sender: "requester",
        title: "Task",
        body: "@test-app-slug do it",
        url: entityUrl,
        entity: { type: entityType, key: "owner/repo#42", url: entityUrl },
        teamAgentTask: { agentUuid: agent.uuid, runId },
      },
      metadata: {
        mentions: [agent.uuid],
        source: "github",
        systemSender: "github",
        teamAgentTask: { agentUuid: agent.uuid, runId },
        githubTaskRun: true,
        githubTaskRunId: runId,
        githubTaskOrganizationId: admin.organizationId,
        githubTaskAgentUuid: agent.uuid,
        githubTaskManagerHumanAgentId: admin.humanAgentUuid,
        githubTaskRepository: "owner/repo",
        githubTaskEntityType: entityType,
        githubTaskEntityNumber: 42,
        githubTaskEntityUrl: entityUrl,
        githubTaskReplySubmission: { state: "pending" },
      },
    },
    { allowSystemSender: true, allowGithubTaskRun: true },
  );
  return { app, admin, agent, runtimeToken, chatId: chat.id, messageId: message.id, runId };
}

function publishInput(
  fixture: Awaited<ReturnType<typeof createRunFixture>>,
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  body = "Done",
) {
  return {
    db: fixture.app.db,
    chatId: fixture.chatId,
    runId: fixture.runId,
    callerAgentUuid: fixture.agent.uuid,
    callerClientId: fixture.admin.clientId,
    callerRuntimeSessionToken: fixture.runtimeToken,
    request: { body },
    appCredentials: fixture.app.config.oauth?.githubApp,
    fetcher,
  };
}

function successfulGithubFetcher(runId: string, permission: "issues" | "pull_requests" = "issues") {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-12-15T18:00:00Z",
          permissions: { metadata: "read", [permission]: "write" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (target.endsWith("/issues/42/comments") && init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as { body: string };
      expect(payload.body).toContain(`first-tree-github-task-reply-run:${runId}`);
      return jsonResponse({
        id: 901,
        html_url: "https://github.com/owner/repo/issues/42#issuecomment-901",
        user: { login: "test-app-slug[bot]" },
        body: payload.body,
      });
    }
    return new Response("not found", { status: 404 });
  });
}

function unknownThenReconciledGithubFetcher(runId: string) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-12-15T18:00:00Z",
          permissions: { metadata: "read", issues: "write" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (target.endsWith("/issues/42/comments") && init?.method === "POST") {
      throw new TypeError("socket closed after request dispatch");
    }
    if (target.endsWith("/issues/42/comments?per_page=100")) {
      return jsonResponse([
        {
          id: 902,
          html_url: "https://github.com/owner/repo/issues/42#issuecomment-902",
          user: { login: "test-app-slug[bot]" },
          body: `Deferred outcome\n\n<!-- first-tree-github-task-reply-run:${runId} -->`,
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });
}

function githubCommentPosts(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetcher.mock.calls.filter(
    ([url, init]) => String(url).endsWith("/issues/42/comments") && init?.method === "POST",
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
