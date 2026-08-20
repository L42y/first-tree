import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type { AgentHandler, SessionContext, SessionMessage } from "../runtime/handler.js";
import { SessionRuntime } from "../runtime/session-runtime.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/**
 * The SessionContext produced by SessionRuntime is the shared inbound
 * boundary every provider's start/resume/inject path funnels through.
 * These tests pin the Team Skill slash-rewrite wiring on that boundary:
 * publish a reconciled base→effective map, and every later
 * formatInboundContent call rewrites the user-typed base command.
 */

function mockSdk(): FirstTreeHubSDK {
  return {
    register: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    listChatParticipants: vi.fn().mockResolvedValue([]),
  } as unknown as FirstTreeHubSDK;
}

function textMessage(content: string): SessionMessage {
  return { id: "m1", chatId: "chat-a", senderId: "sender-1", format: "text", content, metadata: {} };
}

async function captureContext(): Promise<{ ctx: SessionContext; runtime: SessionRuntime }> {
  let capturedCtx: SessionContext | undefined;
  const handler: AgentHandler = {
    start: vi.fn(async (_msg, ctx) => {
      capturedCtx = ctx;
      return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
    }),
    resume: vi.fn(async () => ({ sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } })),
    inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  const runtime = new SessionRuntime({
    session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    concurrency: 5,
    handlerFactory: () => handler,
    handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: mockSdk(),
    log: silentLogger() as unknown as pino.Logger,
    ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
  });
  await runtime.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
  if (!capturedCtx) throw new Error("expected the handler to receive a session context");
  return { ctx: capturedCtx, runtime };
}

const PUBLISHED = [{ key: "resource:review", requestedSlug: "review", name: "review-first-tree" }];

describe("SessionRuntime Team Skill slash rewrite wiring", () => {
  it("rewrites a published base command for every later formatted inbound message", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands?.(PUBLISHED);

    const formatted = await ctx.formatInboundContent(textMessage("/review src/"));
    expect(formatted).toContain("/review-first-tree src/");
    expect(formatted).not.toContain("/review src/");

    await runtime.shutdown();
  });

  it("keeps canonical mention prefixes and leaves prose untouched", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands?.(PUBLISHED);

    expect(await ctx.formatInboundContent(textMessage("@nova /review please"))).toContain(
      "@nova /review-first-tree please",
    );
    expect(await ctx.formatInboundContent(textMessage("hello /review"))).toContain("hello /review");
    expect(await ctx.formatInboundContent(textMessage("hello /review"))).not.toContain("review-first-tree");

    await runtime.shutdown();
  });

  it("passes commands through untouched before any map is published", async () => {
    const { ctx, runtime } = await captureContext();
    const formatted = await ctx.formatInboundContent(textMessage("/review src/"));
    expect(formatted).toContain("/review src/");

    await runtime.shutdown();
  });
});
