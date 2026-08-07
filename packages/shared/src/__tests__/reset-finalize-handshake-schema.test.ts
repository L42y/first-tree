import { describe, expect, it } from "vitest";
import { clientWireCapabilitiesSchema } from "../schemas/client.js";
import {
  sessionCommandAbortedAckFrameSchema,
  sessionCommandAbortedFrameSchema,
  sessionCommandAppliedFrameSchema,
  sessionCommandFinalizedAckFrameSchema,
  sessionCommandFinalizedFrameSchema,
} from "../schemas/session-event.js";

/**
 * Wire contract for the second half of the chat-session Reset handshake. The
 * Reset request stays open until the client's receipt lands, so both skew
 * directions have to be decidable from the frames alone.
 */
describe("Reset finalize handshake frames", () => {
  it("requires a separate ackRef on the finalized frame", () => {
    const ok = sessionCommandFinalizedFrameSchema.safeParse({
      type: "session:command:finalized",
      ref: "term-ref",
      ackRef: "receipt-ref",
      agentId: "agent-1",
      chatId: "chat-1",
      command: "session:terminate",
      state: "evicted",
    });
    expect(ok.success).toBe(true);

    // Without its own rendezvous the receipt would share the terminate ref,
    // where a late cross-replica apply-ack wake could settle it.
    const missingAckRef = sessionCommandFinalizedFrameSchema.safeParse({
      type: "session:command:finalized",
      ref: "term-ref",
      agentId: "agent-1",
      chatId: "chat-1",
      command: "session:terminate",
      state: "evicted",
    });
    expect(missingAckRef.success).toBe(false);
  });

  it("carries both refs plus an explicit release verdict on the receipt", () => {
    const released = sessionCommandFinalizedAckFrameSchema.safeParse({
      type: "session:command:finalized:ack",
      ref: "term-ref",
      ackRef: "receipt-ref",
      agentId: "agent-1",
      chatId: "chat-1",
      command: "session:terminate",
      released: true,
    });
    expect(released.success).toBe(true);

    // A client that saw a stale or superseded generation answers honestly
    // rather than staying silent — the server fails Reset closed on it.
    const refused = sessionCommandFinalizedAckFrameSchema.safeParse({
      type: "session:command:finalized:ack",
      ref: "stale-ref",
      ackRef: "receipt-ref",
      agentId: "agent-1",
      chatId: "chat-1",
      command: "session:terminate",
      released: false,
    });
    expect(refused.success).toBe(true);

    expect(
      sessionCommandFinalizedAckFrameSchema.safeParse({
        type: "session:command:finalized:ack",
        ref: "term-ref",
        ackRef: "receipt-ref",
        agentId: "agent-1",
        chatId: "chat-1",
        command: "session:terminate",
      }).success,
    ).toBe(false);
  });

  it("keeps the receipt distinguishable from the apply-ack", () => {
    // Two separate types, so neither parser can accept the other's frame and
    // resolve the wrong phase of the handshake.
    const receipt = {
      type: "session:command:finalized:ack",
      ref: "term-ref",
      ackRef: "receipt-ref",
      agentId: "agent-1",
      chatId: "chat-1",
      command: "session:terminate",
      released: true,
    };
    expect(sessionCommandAppliedFrameSchema.safeParse(receipt).success).toBe(false);
    expect(
      sessionCommandFinalizedAckFrameSchema.safeParse({
        type: "session:command:applied",
        ref: "term-ref",
        agentId: "agent-1",
        chatId: "chat-1",
        command: "session:terminate",
        applied: true,
      }).success,
    ).toBe(false);
  });

  it("mirrors the finalized pair with a distinct aborted disposition that names its reason", () => {
    // A Reset the server accepted `applied: true` for but could not finalize
    // still owes the client a terminal disposition for that exact ref, or the
    // armed generation stays fenced forever. It is a SEPARATE type from
    // `finalized` so a client can never read "no eviction happened" as
    // "evicted", and it carries the reason so the client can log honestly.
    for (const reason of ["reactivated", "route_refused", "cleanup_failed"] as const) {
      expect(
        sessionCommandAbortedFrameSchema.safeParse({
          type: "session:command:aborted",
          ref: "term-ref",
          ackRef: "abort-ref",
          agentId: "agent-1",
          chatId: "chat-1",
          command: "session:terminate",
          reason,
        }).success,
      ).toBe(true);
    }

    // An abort with no reason, or with an unknown one, is not decidable from
    // the frame alone.
    expect(
      sessionCommandAbortedFrameSchema.safeParse({
        type: "session:command:aborted",
        ref: "term-ref",
        ackRef: "abort-ref",
        agentId: "agent-1",
        chatId: "chat-1",
        command: "session:terminate",
      }).success,
    ).toBe(false);
    expect(
      sessionCommandAbortedFrameSchema.safeParse({
        type: "session:command:aborted",
        ref: "term-ref",
        ackRef: "abort-ref",
        agentId: "agent-1",
        chatId: "chat-1",
        command: "session:terminate",
        reason: "because",
      }).success,
    ).toBe(false);

    // Its own rendezvous ref, exactly like the finalized frame: a late
    // apply-ack or finalize wake must not be able to settle an abort waiter.
    expect(
      sessionCommandAbortedFrameSchema.safeParse({
        type: "session:command:aborted",
        ref: "term-ref",
        agentId: "agent-1",
        chatId: "chat-1",
        command: "session:terminate",
        reason: "reactivated",
      }).success,
    ).toBe(false);

    const abortReceipt = {
      type: "session:command:aborted:ack",
      ref: "term-ref",
      ackRef: "abort-ref",
      agentId: "agent-1",
      chatId: "chat-1",
      command: "session:terminate" as const,
      released: true,
    };
    expect(sessionCommandAbortedAckFrameSchema.safeParse(abortReceipt).success).toBe(true);
    // A stale/superseded ref is answered honestly rather than silently.
    expect(sessionCommandAbortedAckFrameSchema.safeParse({ ...abortReceipt, released: false }).success).toBe(true);
    expect(sessionCommandAbortedAckFrameSchema.safeParse({ ...abortReceipt, released: undefined }).success).toBe(false);

    // No parser may cross the four phases, so no receipt can resolve another
    // phase's waiter and claim a disposition that never happened.
    const finalizedReceipt = { ...abortReceipt, type: "session:command:finalized:ack" };
    expect(sessionCommandAbortedAckFrameSchema.safeParse(finalizedReceipt).success).toBe(false);
    expect(sessionCommandFinalizedAckFrameSchema.safeParse(abortReceipt).success).toBe(false);
    expect(sessionCommandAppliedFrameSchema.safeParse(abortReceipt).success).toBe(false);
    expect(
      sessionCommandFinalizedFrameSchema.safeParse({
        type: "session:command:aborted",
        ref: "term-ref",
        ackRef: "abort-ref",
        agentId: "agent-1",
        chatId: "chat-1",
        command: "session:terminate",
        reason: "reactivated",
      }).success,
    ).toBe(false);
  });

  it("reads a client without the composite Reset capability as unsupported", () => {
    const oldClient = clientWireCapabilitiesSchema.parse({});
    expect(oldClient.wsSessionResetV1).toBe(false);

    const newClient = clientWireCapabilitiesSchema.parse({ wsSessionResetV1: true });
    expect(newClient.wsSessionResetV1).toBe(true);
  });
});
