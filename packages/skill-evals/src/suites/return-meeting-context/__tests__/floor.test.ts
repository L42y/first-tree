import { describe, expect, it } from "vitest";

import {
  RETURN_MEETING_CONTEXT_EVAL_CASES,
  RETURN_MEETING_CONTEXT_GATE_CASES,
  validateReturnMeetingContextFloor,
} from "../cases.js";

describe("return-meeting-context eval floor", () => {
  it("declares implemented semantic gates for the provider-agnostic artifact contract", () => {
    expect(validateReturnMeetingContextFloor(RETURN_MEETING_CONTEXT_EVAL_CASES)).toEqual([]);
    expect(RETURN_MEETING_CONTEXT_GATE_CASES.map((evalCase) => evalCase.fixture.mode)).toEqual([
      "progress-only",
      "later-override",
      "ai-notes",
      "partial-source",
    ]);
  });

  it("keeps every gate synthetic and analysis-only", () => {
    for (const evalCase of RETURN_MEETING_CONTEXT_GATE_CASES) {
      expect(evalCase.prompt).toContain("source-artifacts/bundle.json");
      expect(evalCase.prompt).toContain("meeting-context-output.json");
      expect(evalCase.prompt).toContain("Do not create or modify a Context Tree");
    }
  });
});
