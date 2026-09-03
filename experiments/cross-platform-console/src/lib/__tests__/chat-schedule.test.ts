import { describe, expect, it } from "vitest";

import { formatEntitySubtitle, formatNextRun, scheduleStateLabel } from "../chat-schedule";

describe("chat schedule presentation", () => {
  it("says when the schedule next fires, in the coarsest useful unit", () => {
    const now = Date.parse("2026-02-01T12:00:00.000Z");
    expect(formatNextRun("2026-02-01T12:30:00.000Z", now)).toBe("Next in 30m");
    expect(formatNextRun("2026-02-01T20:00:00.000Z", now)).toBe("Next in 8h");
    expect(formatNextRun("2026-02-04T12:00:00.000Z", now)).toBe("Next in 3d");
    // Sub-minute rounds up rather than claiming "in 0m".
    expect(formatNextRun("2026-02-01T12:00:20.000Z", now)).toBe("Next in 1m");
  });

  it("distinguishes overdue from unscheduled", () => {
    const now = Date.parse("2026-02-01T12:00:00.000Z");
    expect(formatNextRun("2026-02-01T11:00:00.000Z", now)).toBe("Due now");
    expect(formatNextRun(null, now)).toBe("Not scheduled");
    expect(formatNextRun("nonsense", now)).toBe("Not scheduled");
  });

  it("flags only the states that stop a job from running", () => {
    expect(scheduleStateLabel("paused")).toBe("Paused");
    expect(scheduleStateLabel("deleted")).toBe("Deleted");
    expect(scheduleStateLabel("active")).toBeNull();
  });

  it("pairs an entity's key with its live state when there is one", () => {
    expect(formatEntitySubtitle({ entityKey: "o/r#42", state: "open" })).toBe("o/r#42 · open");
    expect(formatEntitySubtitle({ entityKey: "o/r@abc123", state: null })).toBe("o/r@abc123");
  });
});
