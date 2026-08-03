import { describe, expect, it } from "vitest";
import { clientWireCapabilitiesSchema } from "../schemas/client.js";
import {
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

  it("reads a legacy client's register block as having no composite Reset capability", () => {
    // Old client → new server: the server must see the missing composite flag
    // and hide Reset instead of evicting into a fence nobody answers. The
    // legacy apply-only flag is not a substitute at any level of the stack.
    const oldClient = clientWireCapabilitiesSchema.parse({
      wsInboxDeliver: true,
      wsSessionTerminateApplyAck: true,
    });
    expect(oldClient.wsSessionResetV1).toBe(false);

    const newClient = clientWireCapabilitiesSchema.parse({ wsSessionResetV1: true });
    expect(newClient.wsSessionResetV1).toBe(true);
    // A current client withholds the legacy flag entirely, so an old server
    // that gates on it alone cannot read the frame as Reset consent.
    expect(newClient.wsSessionTerminateApplyAck).toBe(false);
  });
});
