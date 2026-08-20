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
 * publish a reconciled command registry, and every later
 * formatInboundContent call rewrites (or fails closed) accordingly.
 */

function mockSdk(): FirstTreeHubSDK {
  return {
    register: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    listChatParticipants: vi.fn().mockResolvedValue([]),
  } as unknown as FirstTreeHubSDK;
}

function textMessage(content: string, mentions?: string[]): SessionMessage {
  return {
    id: "m1",
    chatId: "chat-a",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: mentions ? { mentions } : {},
  };
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

const PUBLISHED = [{ requestedSlug: "review", effectiveName: "review-first-tree" }];

describe("SessionRuntime Team Skill slash rewrite wiring", () => {
  it("rewrites a published base command for every later formatted inbound message", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands?.(PUBLISHED);

    const formatted = await ctx.formatInboundContent(textMessage("/review src/"));
    expect(formatted).toContain("/review-first-tree src/");
    expect(formatted).not.toContain("/review src/");

    await runtime.shutdown();
  });

  it("rewrites a mention-prefixed command only when routed metadata mentions this agent", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands?.(PUBLISHED);

    const routed = await ctx.formatInboundContent(textMessage("@nova /review please", ["agent-1"]));
    expect(routed).toContain("@nova /review-first-tree please");
    // A typed-but-unrouted mention look-alike never unlocks the rewrite.
    const unrouted = await ctx.formatInboundContent(textMessage("@nova /review please"));
    expect(unrouted).toContain("@nova /review please");
    expect(unrouted).not.toContain("review-first-tree");
    expect(await ctx.formatInboundContent(textMessage("hello /review", ["agent-1"]))).toContain("hello /review");

    await runtime.shutdown();
  });

  it("fails closed before the provider when a configured command has no verified target", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands?.([{ requestedSlug: "review", effectiveName: null }]);

    await expect(ctx.formatInboundContent(textMessage("/review src/"))).rejects.toThrow(/no verified installed target/);

    await runtime.shutdown();
  });

  it("atomically replaces the registry on the next publication — stale aliases stop rewriting", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands?.(PUBLISHED);
    expect(await ctx.formatInboundContent(textMessage("/review"))).toContain("/review-first-tree");

    // A new complete projection without the skill clears its alias.
    ctx.publishTeamSkillCommands?.([]);
    expect(await ctx.formatInboundContent(textMessage("/review"))).toContain("/review");
    expect(await ctx.formatInboundContent(textMessage("/review"))).not.toContain("review-first-tree");

    await runtime.shutdown();
  });

  it("blocks strict slash commands until the first registry publication, then lets unknown local commands pass", async () => {
    const { ctx, runtime } = await captureContext();
    // Unpublished: a strict slash command must NOT reach the provider —
    // it could hit a same-named unmanaged Skill before exact Team
    // identities are known. Ordinary text is never blocked.
    await expect(ctx.formatInboundContent(textMessage("/review src/"))).rejects.toThrow(/registry is not published/);
    expect(await ctx.formatInboundContent(textMessage("hello there"))).toContain("hello there");

    // Verified-empty publication: unknown local commands pass through.
    ctx.publishTeamSkillCommands([]);
    expect(await ctx.formatInboundContent(textMessage("/ship it"))).toContain("/ship it");

    await runtime.shutdown();
  });
});
