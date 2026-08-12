import { describe, expect, it } from "vitest";
import {
  clientCapabilitiesSchema,
  runtimeReadinessCheckCommandSchema,
  runtimeReadinessResultSchema,
} from "../index.js";

describe("runtime readiness schemas", () => {
  it("keeps install availability distinct from a real Ready verdict", () => {
    const capabilities = clientCapabilitiesSchema.parse({
      codex: {
        state: "ok",
        available: true,
        detectedAt: "2026-08-12T08:00:00.000Z",
      },
    });
    expect(capabilities.codex?.state).toBe("ok");
    expect(capabilities.codex?.readiness).toBeUndefined();
  });

  it("accepts every safe read-model state", () => {
    for (const state of [
      "available",
      "checking",
      "ready",
      "needs_login",
      "failed",
      "expired",
      "computer_offline",
    ] as const) {
      expect(runtimeReadinessResultSchema.parse({ state }).state).toBe(state);
    }
  });

  it("bounds commands and persisted error previews", () => {
    expect(() =>
      runtimeReadinessCheckCommandSchema.parse({
        type: "runtime-readiness:check",
        provider: "codex",
        config: { model: "x".repeat(257) },
        ref: "ref-1",
      }),
    ).toThrow();
    expect(() =>
      runtimeReadinessResultSchema.parse({
        state: "failed",
        error: { code: "provider_error", message: "x".repeat(501) },
      }),
    ).toThrow();
  });
});
