import { describe, expect, it } from "vitest";
import {
  metadataHasLegacyApplyAckCapability,
  metadataHasSessionResetV1Capability,
  metadataSupportsSessionReset,
} from "../services/session-command-rpc.js";

/**
 * Mixed-fleet matrix for the versioned composite Reset capability.
 *
 * Reset is only safe when BOTH peers speak the same version: the client
 * destroys its provider session on the apply and then parks every intervening
 * inbox row until the server's `session:command:finalized` arrives. A peer
 * that understands only the legacy apply-only flag never sends that signal,
 * so the park would outlive the operator's HTTP 200. `wsSessionResetV1` is
 * therefore one indivisible flag, and the legacy flag is not a fallback in
 * either direction.
 */
describe("Reset capability versioning", () => {
  const meta = (wireCapabilities: Record<string, unknown>) => ({ wireCapabilities });

  /**
   * The predicate an OLD HTTP server applies to a register frame. Reproduced
   * here (rather than imported) precisely because it is the code we no longer
   * ship: the point is what a still-running old replica would conclude.
   */
  const oldServerVerdict = (metadata: unknown): boolean =>
    ((metadata as { wireCapabilities?: Record<string, unknown> } | null)?.wireCapabilities?.[
      "wsSessionTerminateApplyAck"
    ] ?? false) === true;

  it("gates Reset on the composite flag alone", () => {
    expect(metadataSupportsSessionReset(meta({ wsSessionResetV1: true }))).toBe(true);
    expect(metadataHasSessionResetV1Capability(meta({ wsSessionResetV1: true }))).toBe(true);

    // Old client → new server: apply-ack only is recognisably legacy, and
    // legacy is not Reset-ready. The server hides Reset and the preflight
    // fails closed before any destructive command is sent.
    const legacyClient = meta({ wsInboxDeliver: true, wsSessionTerminateApplyAck: true });
    expect(metadataHasLegacyApplyAckCapability(legacyClient)).toBe(true);
    expect(metadataSupportsSessionReset(legacyClient)).toBe(false);

    // A pre-v1 build of the finalize handshake is likewise not v1.
    expect(
      metadataSupportsSessionReset(meta({ wsSessionTerminateApplyAck: true, wsSessionResetFinalizeHandshake: true })),
    ).toBe(false);

    for (const absent of [null, undefined, {}, meta({}), meta({ wsSessionResetV1: false })]) {
      expect(metadataSupportsSessionReset(absent)).toBe(false);
    }
  });

  it("keeps a current client from looking legacy-capable to an old server", () => {
    // New client → old/mixed HTTP server. The current register frame carries
    // ONLY the composite flag, so an old replica gating on the apply-only
    // flag finds no consent, issues no legacy Reset, and cannot return 200
    // without a finalize the client is waiting for.
    const currentClient = meta({ wsSessionResetV1: true });
    expect(oldServerVerdict(currentClient)).toBe(false);
    expect(metadataHasLegacyApplyAckCapability(currentClient)).toBe(false);

    // Sanity: that same old predicate does accept a genuine legacy client, so
    // the assertion above is about the frame, not a broken predicate.
    expect(oldServerVerdict(meta({ wsSessionTerminateApplyAck: true }))).toBe(true);
  });
});
