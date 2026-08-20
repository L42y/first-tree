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

function textMessage(content: string, mentions?: string[], configVersion?: number): SessionMessage {
  return {
    id: "m1",
    chatId: "chat-a",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: mentions ? { mentions } : {},
    configVersion,
  };
}

async function captureContext(): Promise<{
  ctx: SessionContext;
  runtime: SessionRuntime;
  startCount: () => number;
  resumeCount: () => number;
  handlerShutdowns: () => number;
  currentCtx: () => SessionContext;
  startMessages: SessionMessage[];
  injectedMessages: SessionMessage[];
  recoverChat: ReturnType<typeof vi.fn>;
}> {
  let starts = 0;
  let resumes = 0;
  let teardowns = 0;
  let capturedCtx: SessionContext | undefined;
  const startMessages: SessionMessage[] = [];
  const injectedMessages: SessionMessage[] = [];
  const handler: AgentHandler = {
    start: vi.fn(async (msg, ctx) => {
      starts++;
      startMessages.push(msg);
      capturedCtx = ctx;
      return { sessionId: `session-${starts}`, route: { kind: "owned" as const, mode: "queued" as const } };
    }),
    resume: vi.fn(async (_msg, _sessionId, ctx) => {
      resumes++;
      capturedCtx = ctx;
      return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
    }),
    inject: vi.fn((msg) => {
      injectedMessages.push(msg);
      return { kind: "owned", mode: "queued" } as const;
    }),
    suspend: vi.fn(async () => {
      teardowns++;
    }),
    shutdown: vi.fn(async () => {
      teardowns++;
    }),
  };
  const recoverChat = vi.fn().mockResolvedValue(undefined);
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
    recoverChat,
  });
  await runtime.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
  if (!capturedCtx) throw new Error("expected the handler to receive a session context");
  return {
    ctx: capturedCtx,
    runtime,
    startCount: () => starts,
    resumeCount: () => resumes,
    handlerShutdowns: () => teardowns,
    currentCtx: () => {
      if (!capturedCtx) throw new Error("no session context captured");
      return capturedCtx;
    },
    startMessages,
    injectedMessages,
    recoverChat,
  };
}

const PUBLISHED = [{ requestedSlug: "review", effectiveName: "review-first-tree" }];

describe("SessionRuntime Team Skill slash rewrite wiring", () => {
  it("rewrites a published base command for every later formatted inbound message", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands(PUBLISHED, 1);

    const formatted = await ctx.formatInboundContent(textMessage("/review src/"));
    expect(formatted).toContain("/review-first-tree src/");
    expect(formatted).not.toContain("/review src/");

    await runtime.shutdown();
  });

  it("rewrites a mention-prefixed command only when routed metadata mentions this agent", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands(PUBLISHED, 1);

    const routed = await ctx.formatInboundContent(textMessage("@nova /review please", ["agent-1"]));
    expect(routed).toContain("@nova /review-first-tree please");
    // A typed-but-unrouted mention look-alike never unlocks the rewrite.
    const unrouted = await ctx.formatInboundContent(textMessage("@nova /review please"));
    expect(unrouted).toContain("@nova /review please");
    expect(unrouted).not.toContain("review-first-tree");
    expect(await ctx.formatInboundContent(textMessage("hello /review", ["agent-1"]))).toContain("hello /review");

    await runtime.shutdown();
  });

  it("turns a same-version explicitly-unavailable command into an inert notice the provider can settle", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands([{ requestedSlug: "review", effectiveName: null }], 1);

    // Deterministic terminal boundary: the provider receives a First Tree
    // runtime notice with NO slash command token, and the turn can settle
    // normally — no formatter retry, no recovery loop.
    const formatted = await ctx.formatInboundContent(textMessage("/review src/"));
    expect(formatted).toContain("currently unavailable");
    expect(formatted).toContain("no verified installed target");
    expect(formatted).not.toContain("/review");
    expect(formatted).toContain("src/");

    await runtime.shutdown();
  });

  it("atomically replaces the registry on the next publication — stale aliases stop rewriting", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands(PUBLISHED, 1);
    expect(await ctx.formatInboundContent(textMessage("/review"))).toContain("/review-first-tree");

    // A new complete projection without the skill clears its alias.
    ctx.publishTeamSkillCommands([], 1);
    expect(await ctx.formatInboundContent(textMessage("/review"))).toContain("/review");
    expect(await ctx.formatInboundContent(textMessage("/review"))).not.toContain("review-first-tree");

    // Publishing UNKNOWN (e.g. failed hot-switch with unverifiable config)
    // re-blocks strict slash commands instead of keeping the stale map.
    ctx.publishTeamSkillCommands(null, null);
    await expect(ctx.formatInboundContent(textMessage("/review"))).rejects.toThrow(/registry is not published/);
    expect(await ctx.formatInboundContent(textMessage("plain text"))).toContain("plain text");

    await runtime.shutdown();
  });

  it("rewrites image-batch captions with the same registry and fence semantics", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands(PUBLISHED, 1);
    const fileMessage = (caption: string, configVersion = 1, mentions?: string[]): SessionMessage => ({
      id: "m-file",
      chatId: "chat-a",
      senderId: "sender-1",
      format: "file",
      content: { caption, attachments: [{ imageId: "img-1", mimeType: "image/png", filename: "shot.png" }] },
      metadata: mentions ? { mentions } : {},
      configVersion,
    });

    // Bare caption command rewrites identically to text.
    expect(await ctx.formatInboundContent(fileMessage("/review see attached"))).toContain(
      "/review-first-tree see attached",
    );
    // Mention-prefixed caption rewrites only with routed mention metadata.
    expect(await ctx.formatInboundContent(fileMessage("@nova /review", 1, ["agent-1"]))).toContain(
      "@nova /review-first-tree",
    );
    expect(await ctx.formatInboundContent(fileMessage("@nova /review", 1))).toContain("@nova /review");
    // The config-version fence applies to captions too.
    await expect(ctx.formatInboundContent(fileMessage("/review", 2))).rejects.toThrow(/registry is not published/);

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
    ctx.publishTeamSkillCommands([], 1);
    expect(await ctx.formatInboundContent(textMessage("/ship it"))).toContain("/ship it");

    await runtime.shutdown();
  });

  it("fences strict slash commands when the message config version differs from the published registry", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands(PUBLISHED, 1);

    // Message stamped v2 against a v1 registry: strict slash fails closed,
    // ordinary text is unaffected.
    await expect(ctx.formatInboundContent(textMessage("/review src/", undefined, 2))).rejects.toThrow(
      /registry is not published/,
    );
    expect(await ctx.formatInboundContent(textMessage("plain text", undefined, 2))).toContain("plain text");
    // Same-version messages resolve normally.
    expect(await ctx.formatInboundContent(textMessage("/review src/", undefined, 1))).toContain(
      "/review-first-tree src/",
    );

    // Recovery: once reconcile publishes the registry proven for v2, the
    // retried message resolves — no permanent deadlock.
    ctx.publishTeamSkillCommands(PUBLISHED, 2);
    expect(await ctx.formatInboundContent(textMessage("/review src/", undefined, 2))).toContain(
      "/review-first-tree src/",
    );

    await runtime.shutdown();
  });
});

describe("SessionRuntime registry version-mismatch recovery", () => {
  it("drives the production custody chain: tracked message → fence → retry → recovery → fresh handler heals", async () => {
    const cap = await captureContext();
    // The message handed to the handler is the production extractMessage
    // output: it must carry both the inbox custody id and the server
    // config stamp.
    const startMessage = cap.startMessages[0];
    if (!startMessage) throw new Error("expected a start message");
    expect(startMessage.inboxEntryId).toBe(1);
    expect(startMessage.configVersion).toBe(1);

    cap.ctx.publishTeamSkillCommands(PUBLISHED, 1);

    // A v2 strict slash command arrives on the live session: injected with
    // real inbox custody.
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");
    expect(injected.inboxEntryId).toBe(2);
    expect(injected.configVersion).toBe(2);

    // The fence rejects it against the v1 registry and records the marker.
    await expect(cap.ctx.formatInboundContent(injected)).rejects.toThrow(/registry is not published/);

    // The provider retries with custody still pending: recovery fails the
    // session, tears the old handler down, and consults recoverChat.
    cap.ctx.retryTurn(injected, "codex_queued_turn_format_failed");
    await vi.waitFor(() => expect(cap.handlerShutdowns()).toBe(1));
    await vi.waitFor(() => expect(cap.recoverChat).toHaveBeenCalledWith("chat-a"));
    // Recovery settles asynchronously after recoverChat resolves.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Redelivering the SAME entry after recovery: the first dispatch runs
    // the recovery handshake (recoverChat), the second delivers into a
    // fresh handler (via resume, the production post-eviction route).
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(cap.startCount() + cap.resumeCount()).toBe(2));

    // The fresh context starts unpublished; publishing the v2 registry
    // heals the very same message — no permanent retry loop.
    const freshCtx = cap.currentCtx();
    await expect(freshCtx.formatInboundContent(injected)).rejects.toThrow(/registry is not published/);
    freshCtx.publishTeamSkillCommands(PUBLISHED, 2);
    expect(await freshCtx.formatInboundContent(injected)).toContain("/review-first-tree src/");

    await cap.runtime.shutdown();
  });

  it("does not restart when the fenced message has no pending inbox custody", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 1);

    // Synthetic message: fence throws and records the marker, but it never
    // entered the inbox ledger.
    const synthetic = textMessage("/review src/", undefined, 2);
    await expect(cap.ctx.formatInboundContent(synthetic)).rejects.toThrow(/registry is not published/);
    cap.ctx.retryTurn(synthetic, "codex_queued_turn_format_failed");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(cap.handlerShutdowns()).toBe(0);
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "hello again" }));
    expect(cap.startCount()).toBe(1);

    await cap.runtime.shutdown();
  });

  it("clears the fence marker once the same message formats successfully after a refresh", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 1);
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");

    await expect(cap.ctx.formatInboundContent(injected)).rejects.toThrow(/registry is not published/);

    // A concurrent refresh republishes v2; the same message now formats
    // successfully, which must clear its marker...
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 2);
    expect(await cap.ctx.formatInboundContent(injected)).toContain("/review-first-tree src/");

    // ...so a later unrelated retry of that message does NOT restart the
    // session.
    cap.ctx.retryTurn(injected, "some_later_unrelated_retry");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(cap.handlerShutdowns()).toBe(0);

    await cap.runtime.shutdown();
  });

  it("does not restart or retry-loop for a same-version genuinely-unavailable Team command", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands([{ requestedSlug: "review", effectiveName: null }], 1);

    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 1 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");
    // Same-version unavailable is an inert notice, not an error: no marker,
    // no retry, no restart.
    expect(await cap.ctx.formatInboundContent(injected)).toContain("currently unavailable");
    cap.ctx.retryTurn(injected, "unrelated_later_retry");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // No marker, no restart — custody retry semantics stay as-is (recovery
    // debt/redelivery is the ordinary retryTurn behavior for tracked work).
    expect(cap.handlerShutdowns()).toBe(0);
    expect(cap.startCount()).toBe(1);

    await cap.runtime.shutdown();
  });

  it("does not restart the session when a retried message never hit the fence", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 1);
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "hello again", configVersion: 1 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");
    cap.ctx.retryTurn(injected, "some_transient_failure");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(cap.handlerShutdowns()).toBe(0);
    expect(cap.startCount()).toBe(1);

    await cap.runtime.shutdown();
  });
});
