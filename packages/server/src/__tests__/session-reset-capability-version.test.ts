import { describe, expect, it } from "vitest";
import {
  metadataHasSessionResetV1Capability,
  metadataSupportsSessionReset,
} from "../services/runtime/rpc/session-command.js";

/**
 * Matrix for the versioned composite Reset capability.
 *
 * Reset is only safe when BOTH peers speak the same version: the client
 * destroys its provider session on the apply and then parks every intervening
 * inbox row until the server's `session:command:finalized` arrives. A peer
 * that lacks the composite capability cannot promise that signal, so the park
 * would outlive the operator's HTTP 200. `wsSessionResetV1` is therefore one
 * indivisible flag.
 */
describe("Reset capability versioning", () => {
  const meta = (wireCapabilities: Record<string, unknown>) => ({ wireCapabilities });

  it("gates Reset on the composite flag alone", () => {
    expect(metadataSupportsSessionReset(meta({ wsSessionResetV1: true }))).toBe(true);
    expect(metadataHasSessionResetV1Capability(meta({ wsSessionResetV1: true }))).toBe(true);

    const unsupportedClient = meta({});
    expect(metadataSupportsSessionReset(unsupportedClient)).toBe(false);

    // A pre-v1 build of the finalize handshake is likewise not v1.
    expect(metadataSupportsSessionReset(meta({ wsSessionResetFinalizeHandshake: true }))).toBe(false);

    for (const absent of [null, undefined, {}, meta({}), meta({ wsSessionResetV1: false })]) {
      expect(metadataSupportsSessionReset(absent)).toBe(false);
    }
  });
});
