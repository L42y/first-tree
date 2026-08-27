import { describe, expect, it } from "vitest";
import { ProviderAttempt } from "../../../runtime/provider-attempt.js";
import {
  classificationErrorForOpenCodeTurnAbort,
  describeOpenCodeTurnAbortFailure,
  OPENCODE_TURN_ABORT_CLASSIFICATION_MESSAGE,
  resolveOpenCodeTurnAbortCause,
} from "../turn-abort.js";

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

  it("keeps transient settlement classification separate from cause-specific operator text", () => {
    const displayMessage = describeOpenCodeTurnAbortFailure({
      cause: "superseded",
      turnTimeoutMs: 60_000,
      state: { terminalReasons: [], sawProviderActivity: true, text: ["partial"] },
    });
    const classificationError = classificationErrorForOpenCodeTurnAbort("superseded");
    expect(classificationError).toBe(OPENCODE_TURN_ABORT_CLASSIFICATION_MESSAGE);
    expect(classificationError).toContain("timed out");
    expect(displayMessage).toContain("superseded");

    const attempt = new ProviderAttempt({ provider: "opencode", scope: "provider_turn", source: "stream" });
    attempt.markUserVisibleOutput();
    attempt.recordSignal({
      kind: "provider_error",
      error: new Error(classificationError),
      messagePreview: classificationError,
    });
    attempt.recordSignal({
      kind: "diagnostic",
      error: new Error(displayMessage),
      messagePreview: displayMessage,
    });

    const settled = attempt.settle({ attempt: 1 });
    expect(settled?.classification.category).toBe("transient_transport");
    expect(settled?.decision.action).toBe("retry");
    expect(settled?.messagePreview).toContain("superseded");
  });
});
