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

  it("keeps one natural routing prompt and the remaining gates explicitly analysis-only", () => {
    const naturalRoutingCase = RETURN_MEETING_CONTEXT_GATE_CASES.find(
      (evalCase) => evalCase.id === "meeting-later-override-final-decision",
    );
    expect(naturalRoutingCase?.prompt).toBe(
      "Reflect the durable decisions from the supplied meeting minutes at `source-artifacts/bundle.json` into the Context Tree.",
    );
    expect(naturalRoutingCase?.prompt).not.toContain("return-meeting-context");
    expect(naturalRoutingCase?.prompt).not.toContain("meeting-context-output.json");
    expect(naturalRoutingCase?.prompt).not.toContain("For this eval");
    expect(naturalRoutingCase?.fixture.routing).toBe("meeting-vs-write");

    for (const evalCase of RETURN_MEETING_CONTEXT_GATE_CASES.filter(
      (candidate) => candidate.id !== naturalRoutingCase?.id,
    )) {
      expect(evalCase.fixture.routing).toBe("single-skill");
      expect(evalCase.prompt).toContain("source-artifacts/bundle.json");
      expect(evalCase.prompt).toContain("meeting-context-output.json");
      expect(evalCase.prompt).toContain("Do not create or modify a Context Tree");
    }
  });
});
