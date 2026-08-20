import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type { AgentHandler, DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
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
  ackEntry: ReturnType<typeof vi.fn<(entryId: number) => Promise<void>>>;
  currentCtx: () => SessionContext;
  startMessages: SessionMessage[];
  resumeMessages: (SessionMessage | undefined)[];
  injectedMessages: SessionMessage[];
  injectedTokens: DeliveryToken[];
  recoverChat: ReturnType<typeof vi.fn>;
}> {
  let starts = 0;
  let resumes = 0;
  let teardowns = 0;
  let capturedCtx: SessionContext | undefined;
  const startMessages: SessionMessage[] = [];
  const resumeMessages: (SessionMessage | undefined)[] = [];
  const injectedMessages: SessionMessage[] = [];
  const injectedTokens: DeliveryToken[] = [];
  const handler: AgentHandler = {
    start: vi.fn(async (msg, ctx) => {
      starts++;
      startMessages.push(msg);
      capturedCtx = ctx;
      return { sessionId: `session-${starts}`, route: { kind: "owned" as const, mode: "queued" as const } };
    }),
    resume: vi.fn(async (msg, _sessionId, ctx) => {
      resumes++;
      resumeMessages.push(msg);
      capturedCtx = ctx;
      return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
    }),
    inject: vi.fn((msg, token) => {
      injectedMessages.push(msg);
      injectedTokens.push(token);
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
  const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
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
    ackEntry,
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
    resumeMessages,
    injectedMessages,
    injectedTokens,
    recoverChat,
    ackEntry,
  };
}

const REVIEW_RESOURCE_ID = "res-review-1";
const PUBLISHED = [{ requestedSlug: "review", resourceId: REVIEW_RESOURCE_ID, effectiveName: "review-first-tree" }];

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
    ctx.publishTeamSkillCommands([{ requestedSlug: "review", resourceId: REVIEW_RESOURCE_ID, effectiveName: null }], 1);

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
    // re-blocks strict slash commands — now as an inert notice rather
    // than keeping the stale map.
    ctx.publishTeamSkillCommands(null, null);
    const blocked = await ctx.formatInboundContent(textMessage("/review"));
    expect(blocked).toContain("could not be verified");
    expect(blocked).not.toContain("/review");
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
    // The config-version fence applies to captions too — and with no
    // inbox custody the mismatch settles as an inert notice, not a throw.
    const fencedCaption = await ctx.formatInboundContent(fileMessage("/review", 2));
    expect(fencedCaption).toContain("could not be verified");
    expect(fencedCaption).not.toContain("/review");

    await runtime.shutdown();
  });

  it("gives an unstamped strict slash command an inert notice while the registry is null — zero throw, zero retry", async () => {
    const { ctx, runtime } = await captureContext();
    // Unstamped + null registry: there is no provable recovery axis, so
    // the command becomes an inert notice instead of an exception the
    // provider would retry into the same failure. Ordinary text is never
    // affected.
    const formatted = await ctx.formatInboundContent(textMessage("/review src/"));
    expect(formatted).toContain("could not be verified");
    expect(formatted).not.toContain("/review");
    expect(await ctx.formatInboundContent(textMessage("hello there"))).toContain("hello there");

    // Verified-empty publication: unknown local commands pass through.
    ctx.publishTeamSkillCommands([], 1);
    expect(await ctx.formatInboundContent(textMessage("/ship it"))).toContain("/ship it");

    await runtime.shutdown();
  });

  it("fences strict slash commands when the message config version differs from the published registry", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands(PUBLISHED, 1);

    // Message stamped v2 against a v1 registry WITHOUT inbox custody:
    // no recovery axis exists, so the strict slash settles as an inert
    // notice instead of a recoverable throw. Ordinary text is unaffected.
    const fenced = await ctx.formatInboundContent(textMessage("/review src/", undefined, 2));
    expect(fenced).toContain("could not be verified");
    expect(fenced).not.toContain("/review");
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

  it("resolves a server-marked Team command fail-closed across a delayed delivery", async () => {
    const { ctx, runtime } = await captureContext();
    const markedMessage = (
      content: string,
      overrides: { resourceId?: string; requestedSlug?: string; configVersion?: number; recipientAgentId?: string },
      deliveryStamp?: number,
    ): SessionMessage => ({
      id: "m-marked",
      chatId: "chat-a",
      senderId: "sender-1",
      format: "text",
      content,
      metadata: {
        teamSkillInvocation: {
          version: 1,
          recipientAgentId: overrides.recipientAgentId ?? "agent-1",
          resourceId: overrides.resourceId ?? REVIEW_RESOURCE_ID,
          requestedSlug: overrides.requestedSlug ?? "review",
          configVersion: overrides.configVersion ?? 1,
        },
      },
      configVersion: deliveryStamp,
    });

    // The happy path: marker, current agent, registry version, slug AND
    // resourceId all agree — the command rewrites to the exact verified
    // effective name.
    ctx.publishTeamSkillCommands(PUBLISHED, 1);
    expect(await ctx.formatInboundContent(markedMessage("/review src/", {}))).toContain("/review-first-tree src/");

    // Delayed delivery: chosen at v1, the config moved to v2 before the
    // message was formatted. The delivery stamp matches the registry, but
    // the MARKER version does not — the command settles as a terminal
    // stale notice, never a same-named local Skill.
    ctx.publishTeamSkillCommands(PUBLISHED, 2);
    const stale = await ctx.formatInboundContent(markedMessage("/review src/", {}, 2));
    expect(stale).toContain("superseded");
    expect(stale).not.toContain("/review");

    // Same-slug replacement: the registry's ready row belongs to a NEW
    // resource reusing the slug — the old invocation must not execute it.
    ctx.publishTeamSkillCommands(
      [{ requestedSlug: "review", resourceId: "res-new-owner", effectiveName: "review" }],
      1,
    );
    const replaced = await ctx.formatInboundContent(markedMessage("/review src/", {}));
    expect(replaced).toContain("removed or renamed");
    expect(replaced).not.toContain("/review");
    expect(replaced).toContain("src/");

    // Registry no longer knows the slug at all: same fail-closed notice.
    ctx.publishTeamSkillCommands([], 1);
    const removed = await ctx.formatInboundContent(markedMessage("/review src/", {}));
    expect(removed).toContain("removed or renamed");
    expect(removed).not.toContain("/review");

    // A marker addressed to a DIFFERENT agent (misrouted copy) never runs here.
    ctx.publishTeamSkillCommands(PUBLISHED, 1);
    const misrouted = await ctx.formatInboundContent(markedMessage("/review src/", { recipientAgentId: "agent-2" }));
    expect(misrouted).toContain("could not be verified");
    expect(misrouted).not.toContain("/review");

    // Hand-edited text that no longer starts with the marked command is
    // treated as an ordinary (possibly local) command.
    expect(await ctx.formatInboundContent(markedMessage("/ship src/", {}))).toContain("/ship src/");

    await runtime.shutdown();
  });

  it("treats a present-but-malformed invocation marker as unverifiable Team intent — never a local command", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands(PUBLISHED, 1);
    const malformedMessage = (marker: unknown): SessionMessage => ({
      id: "m-malformed",
      chatId: "chat-a",
      senderId: "sender-1",
      format: "text",
      content: "/review src/",
      metadata: { teamSkillInvocation: marker },
      configVersion: 1,
    });

    for (const bad of [
      "review",
      {
        version: 2,
        recipientAgentId: "agent-1",
        resourceId: REVIEW_RESOURCE_ID,
        requestedSlug: "review",
        configVersion: 1,
      },
      { version: 1, recipientAgentId: "agent-1", resourceId: REVIEW_RESOURCE_ID, requestedSlug: "review" },
      { resourceId: REVIEW_RESOURCE_ID, slug: "review", configVersion: 1 },
    ]) {
      const formatted = await ctx.formatInboundContent(malformedMessage(bad));
      expect(formatted).toContain("could not be verified");
      expect(formatted).not.toContain("/review");
    }

    // Only a truly ABSENT key keeps the ordinary local/runtime semantics.
    expect(await ctx.formatInboundContent(textMessage("/ship it", undefined, 1))).toContain("/ship it");

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

    // Production order: the fresh handler's preparation republishes BEFORE
    // any turn is formatted. Publishing the v2 registry heals the very same
    // message the fresh handler actually received — no permanent retry loop.
    const freshCtx = cap.currentCtx();
    freshCtx.publishTeamSkillCommands(PUBLISHED, 2);
    const redelivered = cap.resumeMessages[cap.resumeMessages.length - 1];
    if (!redelivered) throw new Error("expected the fresh handler to receive a redelivered message");
    expect(redelivered.id).toBe(injected.id);
    expect(redelivered.inboxEntryId).toBe(injected.inboxEntryId);
    expect(await freshCtx.formatInboundContent(redelivered)).toContain("/review-first-tree src/");

    await cap.runtime.shutdown();
  });

  it("bounds an unresolvable registry: one recovery, then a terminal notice and ACK — never a third handler", async () => {
    const cap = await captureContext();
    // Preparation completes but proves NOTHING: first null publication.
    cap.ctx.publishTeamSkillCommands(null, null);

    const startMessage = cap.startMessages[0];
    if (!startMessage) throw new Error("expected a start message");
    await cap.ctx.finishTurn(startMessage, { status: "success", terminal: true });

    // A tracked strict-slash message arrives stamped v2 while the
    // registry is UNRESOLVED.
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");
    expect(injected.inboxEntryId).toBe(2);
    expect(injected.configVersion).toBe(2);

    // First fence: recoverable throw — one fresh preparation gets a chance.
    await expect(cap.ctx.formatInboundContent(injected)).rejects.toThrow(/registry is not published/);
    cap.ctx.retryTurn(injected, "codex_queued_turn_format_failed");
    await vi.waitFor(() => expect(cap.handlerShutdowns()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Redelivery handshake, then delivery into the fresh handler.
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(cap.startCount() + cap.resumeCount()).toBe(2));

    // The fresh preparation ALSO proves nothing (second consecutive null):
    // provably no progress, so the bounded terminal boundary fires. The
    // message is the one the FRESH handler actually received on resume —
    // same inboxEntryId, config stamp, and message id as the original.
    const freshCtx = cap.currentCtx();
    freshCtx.publishTeamSkillCommands(null, null);
    const redelivered = cap.resumeMessages[cap.resumeMessages.length - 1];
    if (!redelivered) throw new Error("expected the fresh handler to receive a redelivered message");
    expect(redelivered.id).toBe(injected.id);
    expect(redelivered.inboxEntryId).toBe(injected.inboxEntryId);
    expect(redelivered.configVersion).toBe(2);
    const formatted = await freshCtx.formatInboundContent(redelivered);
    expect(formatted).toContain("could not be verified");
    expect(formatted).not.toContain("/review");

    // The turn settles through the production completion path; nothing
    // recovers again and no third handler ever starts.
    await freshCtx.finishTurn(redelivered, { status: "success", terminal: true });
    expect(cap.ackEntry).toHaveBeenCalledWith(2);
    expect(freshCtx.hasPendingDelivery?.([injected])).toBe(false);
    expect(cap.startCount() + cap.resumeCount()).toBe(2);
    // Exactly one recovery cycle total — never a loop.
    expect(cap.recoverChat).toHaveBeenCalledTimes(1);

    await cap.runtime.shutdown();
  });

  it("settles a stale-version message with an immediate terminal notice — zero recovery, zero restart", async () => {
    const cap = await captureContext();
    // The session already runs a registry proven for config v2.
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 2);

    const startMessage = cap.startMessages[0];
    if (!startMessage) throw new Error("expected a start message");
    await cap.ctx.finishTurn(startMessage, { status: "success", terminal: true });

    // But this tracked command was stamped back at v1: its configuration
    // has been superseded, and no recovery can republish history.
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 1 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");
    expect(injected.configVersion).toBe(1);

    const formatted = await cap.ctx.formatInboundContent(injected);
    expect(formatted).toContain("superseded");
    expect(formatted).not.toContain("/review");

    await cap.ctx.finishTurn(injected, { status: "success", terminal: true });
    expect(cap.ackEntry).toHaveBeenCalledWith(2);
    expect(cap.handlerShutdowns()).toBe(0);
    expect(cap.recoverChat).not.toHaveBeenCalled();
    expect(cap.startCount()).toBe(1);

    await cap.runtime.shutdown();
  });

  it("bounds an ahead-of-registry message to one recovery, then a terminal notice when the fresh publication does not advance", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 1);

    const startMessage = cap.startMessages[0];
    if (!startMessage) throw new Error("expected a start message");
    await cap.ctx.finishTurn(startMessage, { status: "success", terminal: true });

    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");

    // The handler is behind: one fresh recovery is allowed.
    await expect(cap.ctx.formatInboundContent(injected)).rejects.toThrow(/registry is not published/);
    cap.ctx.retryTurn(injected, "codex_queued_turn_format_failed");
    await vi.waitFor(() => expect(cap.handlerShutdowns()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(cap.startCount() + cap.resumeCount()).toBe(2));

    // The fresh preparation re-publishes the SAME v1 registry — provably
    // no progress — so the redelivered message (the one the fresh handler
    // actually received) hits the terminal boundary.
    const freshCtx = cap.currentCtx();
    freshCtx.publishTeamSkillCommands(PUBLISHED, 1);
    const redelivered = cap.resumeMessages[cap.resumeMessages.length - 1];
    if (!redelivered) throw new Error("expected the fresh handler to receive a redelivered message");
    expect(redelivered.id).toBe(injected.id);
    expect(redelivered.configVersion).toBe(2);
    const formatted = await freshCtx.formatInboundContent(redelivered);
    expect(formatted).toContain("could not be verified");
    expect(formatted).not.toContain("/review");

    await freshCtx.finishTurn(redelivered, { status: "success", terminal: true });
    expect(cap.ackEntry).toHaveBeenCalledWith(2);
    expect(freshCtx.hasPendingDelivery?.([redelivered])).toBe(false);
    expect(cap.startCount() + cap.resumeCount()).toBe(2);
    expect(cap.recoverChat).toHaveBeenCalledTimes(1);

    await cap.runtime.shutdown();
  });

  it("keeps recovery chances independent per message: one message's recovery does not consume another's", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 1);

    // First tracked message: real custody, real recovery cycle.
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review one", configVersion: 2 }));
    const first = cap.injectedMessages[0];
    if (!first) throw new Error("expected the first message to inject");
    await expect(cap.ctx.formatInboundContent(first)).rejects.toThrow(/registry is not published/);
    cap.ctx.retryTurn(first, "codex_queued_turn_format_failed");
    await vi.waitFor(() => expect(cap.handlerShutdowns()).toBe(1));

    // A second, UNRELATED tracked message on the same chat must still get
    // its OWN first recoverable throw — the first message's attempt
    // marker must not poison it. Dispatch it into the fresh handler.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 3, chatId: "chat-a", content: "/review two", configVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 3, chatId: "chat-a", content: "/review two", configVersion: 2 }));
    await vi.waitFor(() => expect(cap.startCount() + cap.resumeCount()).toBe(2));
    const freshCtx = cap.currentCtx();
    const second = cap.resumeMessages[cap.resumeMessages.length - 1];
    if (!second) throw new Error("expected the second message to be redelivered to the fresh handler");
    await expect(freshCtx.formatInboundContent(second)).rejects.toThrow(/registry is not published/);

    // While the FIRST message, with its attempt marker, is now terminal.
    const terminal = await freshCtx.formatInboundContent(first);
    expect(terminal).toContain("could not be verified");
    expect(terminal).not.toContain("/review");

    await cap.runtime.shutdown();
  });

  it("keeps the old handler's registry snapshot isolated from a fresh handler's publication", async () => {
    const cap = await captureContext();
    const oldCtx = cap.ctx;
    oldCtx.publishTeamSkillCommands(PUBLISHED, 1);

    // Drive a REAL recovery on the same runtime so both handlers exist.
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");
    await expect(oldCtx.formatInboundContent(injected)).rejects.toThrow(/registry is not published/);
    oldCtx.retryTurn(injected, "codex_queued_turn_format_failed");
    await vi.waitFor(() => expect(cap.handlerShutdowns()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(cap.startCount() + cap.resumeCount()).toBe(2));

    // The fresh handler publishes its own v2 registry.
    const freshCtx = cap.currentCtx();
    freshCtx.publishTeamSkillCommands(PUBLISHED, 2);

    // The OLD context still resolves against its OWN v1 snapshot: a v1
    // message rewrites through it, and a v2 message must NOT see the
    // fresh v2 registry — it settles against the OLD snapshot instead.
    expect(await oldCtx.formatInboundContent(textMessage("/review", undefined, 1))).toContain("/review-first-tree");
    const staleOnOld = await oldCtx.formatInboundContent(textMessage("/review", undefined, 2));
    expect(staleOnOld).toContain("could not be verified");
    expect(staleOnOld).not.toContain("/review-first-tree");

    await cap.runtime.shutdown();
  });

  it("settles a stamped mismatch with no pending inbox custody as an inert notice — zero throw, zero retry", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 1);

    // Synthetic stamped message: version-mismatched and never entered the
    // inbox ledger, so there is no recovery axis at all.
    const formatted = await cap.ctx.formatInboundContent(textMessage("/review src/", undefined, 2));
    expect(formatted).toContain("could not be verified");
    expect(formatted).not.toContain("/review");

    // Nothing retries, restarts, or requests recovery; ordinary text and
    // known-registry commands keep working.
    expect(cap.handlerShutdowns()).toBe(0);
    expect(cap.recoverChat).not.toHaveBeenCalled();
    expect(await cap.ctx.formatInboundContent(textMessage("hello there"))).toContain("hello there");
    expect(await cap.ctx.formatInboundContent(textMessage("/review", undefined, 1))).toContain("/review-first-tree");

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

  it("settles a same-version unavailable command with one inert notice and one ACK — terminal custody evidence", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands(
      [{ requestedSlug: "review", resourceId: REVIEW_RESOURCE_ID, effectiveName: null }],
      1,
    );

    // Settle the opening turn first so the ledger prefix is terminal, as
    // any healthy session would before the next message settles.
    const startMessage = cap.startMessages[0];
    if (!startMessage) throw new Error("expected a start message");
    await cap.ctx.finishTurn(startMessage, { status: "success", terminal: true });

    // A tracked inbox entry carries the unavailable Team command at the
    // SAME config version the registry proves.
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 1 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");
    expect(injected.inboxEntryId).toBe(2);
    expect(injected.configVersion).toBe(1);

    // The provider view is exactly one inert notice: it names the Skill
    // without ever containing the `/review` command literal.
    const formatted = await cap.ctx.formatInboundContent(injected);
    expect(formatted).toContain("currently unavailable");
    expect(formatted).toContain('"review"');
    expect(formatted).not.toContain("/review");

    // The handler settles the turn through the production completion path.
    await cap.ctx.finishTurn(injected, { status: "success", terminal: true });
    expect(cap.ackEntry).toHaveBeenCalledWith(2);
    expect(cap.ackEntry).toHaveBeenCalledTimes(2);
    expect(cap.ctx.hasPendingDelivery?.([injected])).toBe(false);
    expect(cap.handlerShutdowns()).toBe(0);
    expect(cap.recoverChat).not.toHaveBeenCalled();

    // Nothing loops: no recovery request, no handler churn, no redelivery
    // machinery fires after the settle. (An explicit server redelivery of
    // a committed entry may be reprocessed by the platform's at-least-once
    // dedup window — pre-existing inbox semantics, independent of this
    // notice path.)
    expect(cap.recoverChat).not.toHaveBeenCalled();
    expect(cap.startCount()).toBe(1);
    expect(cap.handlerShutdowns()).toBe(0);

    await cap.runtime.shutdown();
  });

  it("keeps the marker through an ACK failure: redelivery still notices, reclaim happens only at ACK commit", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 1);

    const startMessage = cap.startMessages[0];
    if (!startMessage) throw new Error("expected a start message");
    await cap.ctx.finishTurn(startMessage, { status: "success", terminal: true });

    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    const injected = cap.injectedMessages[0];
    if (!injected) throw new Error("expected the message to inject into the live session");
    await expect(cap.ctx.formatInboundContent(injected)).rejects.toThrow(/registry is not published/);
    cap.ctx.retryTurn(injected, "codex_queued_turn_format_failed");
    await vi.waitFor(() => expect(cap.handlerShutdowns()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(cap.startCount() + cap.resumeCount()).toBe(2));

    const freshCtx = cap.currentCtx();
    freshCtx.publishTeamSkillCommands(PUBLISHED, 1);
    const redelivered = cap.resumeMessages[cap.resumeMessages.length - 1];
    if (!redelivered) throw new Error("expected the fresh handler to receive a redelivered message");
    const notice = await freshCtx.formatInboundContent(redelivered);
    expect(notice).toContain("could not be verified");

    // The terminal notice does NOT clear the marker: the provider could
    // still fail, and the ACK has not happened yet.
    const markerSeam = cap.runtime as unknown as {
      hasFenceRecoveryAttempt(chatId: string, messageId: string): boolean;
    };
    cap.ackEntry.mockRejectedValueOnce(new Error("ack temporarily unavailable"));
    await freshCtx.finishTurn(redelivered, { status: "success", terminal: true });
    expect(markerSeam.hasFenceRecoveryAttempt("chat-a", redelivered.id)).toBe(true);
    // Re-formatting after the failed ACK still produces the notice — the
    // message does not mint a second recovery chance.
    const again = await freshCtx.formatInboundContent(redelivered);
    expect(again).toContain("could not be verified");
    expect(cap.startCount() + cap.resumeCount()).toBe(2);

    // The redelivery retries the settlement; once the ACK finally
    // commits, the marker is reclaimed at the commit callback.
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(cap.ackEntry).toHaveBeenCalledTimes(3));
    expect(markerSeam.hasFenceRecoveryAttempt("chat-a", redelivered.id)).toBe(false);

    await cap.runtime.shutdown();
  });

  it("drives the fence recovery through the provider's REAL DeliveryToken.retry", async () => {
    const cap = await captureContext();
    cap.ctx.publishTeamSkillCommands(PUBLISHED, 1);

    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    const injected = cap.injectedMessages[0];
    const token = cap.injectedTokens[0];
    if (!injected || !token) throw new Error("expected the injected message and its production DeliveryToken");
    await expect(cap.ctx.formatInboundContent(injected)).rejects.toThrow(/registry is not published/);

    // The provider retries through the REAL DeliveryToken — the unified
    // consumption point — not SessionContext.retryTurn.
    token.retry(injected, "team_skill_command_unavailable");
    await vi.waitFor(() => expect(cap.handlerShutdowns()).toBe(1));
    await vi.waitFor(() => expect(cap.recoverChat).toHaveBeenCalledWith("chat-a"));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cap.runtime.dispatch(mockEntry({ id: 2, chatId: "chat-a", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(cap.startCount() + cap.resumeCount()).toBe(2));

    const freshCtx = cap.currentCtx();
    freshCtx.publishTeamSkillCommands(PUBLISHED, 2);
    const redelivered = cap.resumeMessages[cap.resumeMessages.length - 1];
    if (!redelivered) throw new Error("expected the fresh handler to receive a redelivered message");
    expect(await freshCtx.formatInboundContent(redelivered)).toContain("/review-first-tree src/");

    await cap.runtime.shutdown();
  });

  it("bounds a fenced FIRST message: handler.start throw consumes through the runtime failure path — no generic backoff", async () => {
    let starts = 0;
    let latestCtx: SessionContext | undefined;
    const handler: AgentHandler = {
      start: vi.fn(async (msg, ctx) => {
        starts++;
        latestCtx = ctx;
        // First start proves v1; the fresh start after recovery proves v2.
        ctx.publishTeamSkillCommands(PUBLISHED, starts === 1 ? 1 : 2);
        await ctx.formatInboundContent(msg);
        return { sessionId: `session-${starts}`, route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      resume: vi.fn(async () => ({
        sessionId: "session-1",
        route: { kind: "owned" as const, mode: "queued" as const },
      })),
      inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
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

    // The very first tracked message IS the fenced strict slash.
    await runtime.dispatch(mockEntry({ id: 1, chatId: "chat-b", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-b"));
    // Redelivery after recovery starts a FRESH handler (second start).
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.dispatch(mockEntry({ id: 1, chatId: "chat-b", content: "/review src/", configVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.dispatch(mockEntry({ id: 1, chatId: "chat-b", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(starts).toBe(2));

    // The fresh start published v2 and formatted successfully.
    if (!latestCtx) throw new Error("expected a fresh context");
    await runtime.shutdown();
  });

  it("bounds a fenced FIRST message with an unresolved fresh preparation: notice and ACK, no third handler", async () => {
    let starts = 0;
    let freshCtx: SessionContext | undefined;
    let freshMessage: SessionMessage | undefined;
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    // A NEW handler instance per fresh handler — production never reuses a
    // retired handler object (the teardown registry keys on identity).
    const makeStartHandler = (): AgentHandler => ({
      start: vi.fn(async (msg, ctx) => {
        starts++;
        if (starts === 1) {
          // The first start proves v1; the fenced first message throws out
          // of handler.start into the runtime failure path.
          ctx.publishTeamSkillCommands(PUBLISHED, 1);
          await ctx.formatInboundContent(msg);
          return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
        }
        // The fresh start STILL cannot prove any registry (null); the
        // redelivered message's format settles as the bounded notice.
        freshCtx = ctx;
        freshMessage = msg;
        ctx.publishTeamSkillCommands(null, null);
        return { sessionId: "session-2", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      resume: vi.fn(async () => ({
        sessionId: "session-2",
        route: { kind: "owned" as const, mode: "queued" as const },
      })),
      inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    const runtime = new SessionRuntime({
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: () => makeStartHandler(),
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
      ackEntry,
      recoverChat,
    });

    // The very first tracked message IS the fenced strict slash: start
    // throws, the runtime consumes the pending failure through the
    // bounded recovery (never the generic indefinite backoff).
    await runtime.dispatch(mockEntry({ id: 1, chatId: "chat-c", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-c"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.dispatch(mockEntry({ id: 1, chatId: "chat-c", content: "/review src/", configVersion: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.dispatch(mockEntry({ id: 1, chatId: "chat-c", content: "/review src/", configVersion: 2 }));
    await vi.waitFor(() => expect(starts).toBe(2));

    // The redelivered message reached the fresh start with the SAME
    // identity, its preparation published null: bounded notice, then a
    // PRODUCTION finishTurn completion — exactly one ACK, no third
    // handler, exactly one recovery.
    if (!freshCtx || !freshMessage) throw new Error("expected the fresh handler to receive the redelivered message");
    expect(freshMessage.id).toBe("msg-1");
    expect(freshMessage.inboxEntryId).toBe(1);
    expect(freshMessage.configVersion).toBe(2);
    const notice = await freshCtx.formatInboundContent(freshMessage);
    expect(notice).toContain("could not be verified");
    expect(notice).not.toContain("/review");
    await freshCtx.finishTurn(freshMessage, { status: "success", terminal: true });
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(1));
    expect(freshCtx.hasPendingDelivery?.([freshMessage])).toBe(false);
    expect(starts).toBe(2);
    expect(recoverChat).toHaveBeenCalledTimes(1);

    await runtime.shutdown();
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

describe("SessionRuntime multi-recipient ambiguity", () => {
  it("turns any strict slash addressed to multiple routed agents into an ambiguous-recipient notice", async () => {
    const { ctx, runtime } = await captureContext();
    ctx.publishTeamSkillCommands(PUBLISHED, 1);

    // Mention-prefixed multi-recipient: not run by ANY agent.
    const multi = textMessage("@nova @design /review", ["agent-1", "agent-2"], 1);
    const formatted = await ctx.formatInboundContent(multi);
    expect(formatted).toContain("multiple agents");
    expect(formatted).not.toContain("/review");
    expect(formatted).not.toContain("review-first-tree");

    // Bare slash with two routed recipients: same treatment.
    const bare = await ctx.formatInboundContent(textMessage("/review", ["agent-1", "agent-2"], 1));
    expect(bare).toContain("multiple agents");
    expect(bare).not.toContain("/review");

    // Ordinary text with two recipients is unaffected.
    expect(
      await ctx.formatInboundContent(textMessage("@nova @design hello team", ["agent-1", "agent-2"], 1)),
    ).toContain("@nova @design hello team");

    // A single routed recipient keeps the rewrite.
    expect(await ctx.formatInboundContent(textMessage("@nova /review", ["agent-1"], 1))).toContain(
      "/review-first-tree",
    );

    await runtime.shutdown();
  });

  it("coerces a null-commands publication with a non-null version to version null", async () => {
    const { ctx, runtime } = await captureContext();
    // A caller bug must not create "registry null + matching version",
    // which would skip the mismatch park path and throw without recovery.
    ctx.publishTeamSkillCommands(null, 5);
    const formatted = await ctx.formatInboundContent(textMessage("/review src/", undefined, 5));
    expect(formatted).toContain("could not be verified");
    expect(formatted).not.toContain("/review");

    await runtime.shutdown();
  });
});
