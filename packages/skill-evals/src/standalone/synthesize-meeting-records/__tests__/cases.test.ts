import { describe, expect, it } from "vitest";

import { SYNTHESIZE_MEETING_RECORDS_CASES } from "../cases.js";

describe("standalone synthesize-meeting-records cases", () => {
  it("covers each required model-owned behavior", () => {
    expect(SYNTHESIZE_MEETING_RECORDS_CASES.map((evalCase) => evalCase.fixture.mode).sort()).toEqual([
      "ai-only",
      "later-override",
      "partial-source",
      "six-categories",
    ]);
    expect(
      SYNTHESIZE_MEETING_RECORDS_CASES.find((evalCase) => evalCase.fixture.mode === "six-categories"),
    ).toMatchObject({
      expected: {
        categories: ["action", "blocker", "decision", "plan", "progress", "risk"],
        itemCount: 6,
        settlement: "confirmed",
      },
    });
    expect(
      SYNTHESIZE_MEETING_RECORDS_CASES.find((evalCase) => evalCase.fixture.mode === "partial-source"),
    ).toMatchObject({
      expected: {
        itemCount: 0,
        status: "blocked-source",
      },
    });
  });

  it("uses natural prompts without preselecting the skill or describing evaluator internals", () => {
    for (const evalCase of SYNTHESIZE_MEETING_RECORDS_CASES) {
      expect(evalCase.prompt).not.toContain("synthesize-meeting-records");
      expect(evalCase.prompt.toLowerCase()).not.toContain("for this eval");
      expect(evalCase.prompt.toLowerCase()).not.toContain("use the skill");
    }
  });
});
