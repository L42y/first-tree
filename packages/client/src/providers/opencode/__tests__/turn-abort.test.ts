import { describe, expect, it } from "vitest";
import { describeOpenCodeTurnAbortFailure, resolveOpenCodeTurnAbortCause } from "../turn-abort.js";

describe("resolveOpenCodeTurnAbortCause", () => {
  it("prefers timeout over other abort signals", () => {
    expect(
      resolveOpenCodeTurnAbortCause({
        turnGeneration: 2,
        currentGeneration: 3,
        sessionActive: false,
        timedOut: true,
        abortSignal: AbortSignal.abort(),
      }),
    ).toBe("timeout");
  });

  it("classifies inactive sessions", () => {
    expect(
      resolveOpenCodeTurnAbortCause({
        turnGeneration: 2,
        currentGeneration: 2,
        sessionActive: false,
        timedOut: false,
        abortSignal: AbortSignal.abort(),
      }),
    ).toBe("session_inactive");
  });

  it("classifies superseded turns", () => {
    expect(
      resolveOpenCodeTurnAbortCause({
        turnGeneration: 2,
        currentGeneration: 3,
        sessionActive: true,
        timedOut: false,
        abortSignal: AbortSignal.abort(),
      }),
    ).toBe("superseded");
  });
});

describe("describeOpenCodeTurnAbortFailure", () => {
  it("names timeout duration and missing terminal events", () => {
    expect(
      describeOpenCodeTurnAbortFailure({
        cause: "timeout",
        turnTimeoutMs: 60_000,
        state: { terminalReasons: [], sawProviderActivity: true, text: [] },
      }),
    ).toBe(
      "OpenCode turn timed out after 60s before a safe terminal event (step_finish). no step_finish event received; provider activity without assistant text.",
    );
  });

  it("notes superseded deliveries and partial text", () => {
    expect(
      describeOpenCodeTurnAbortFailure({
        cause: "superseded",
        turnTimeoutMs: 1_200_000,
        state: { terminalReasons: [], sawProviderActivity: true, text: ["partial"] },
      }),
    ).toBe(
      "OpenCode turn was superseded by a newer delivery before a safe terminal event (step_finish). no step_finish event received; partial assistant text was captured.",
    );
  });
});
