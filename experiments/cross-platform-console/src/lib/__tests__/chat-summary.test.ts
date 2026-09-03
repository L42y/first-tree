import { describe, expect, it } from "vitest";

import { buildChatSummary, formatSummaryAge, isUpdatedSinceRead } from "../chat-summary";

describe("chat summary", () => {
  it("is absent until an agent has actually written one", () => {
    expect(buildChatSummary({ description: null })).toBeNull();
    expect(buildChatSummary({ description: "   " })).toBeNull();
    expect(buildChatSummary({ description: "Shipped the picker." })?.text).toBe("Shipped the picker.");
  });

  it("counts as unread only when it was written after the reader's last visit", () => {
    expect(isUpdatedSinceRead("2026-02-01T12:00:00.000Z", "2026-02-01T11:00:00.000Z")).toBe(true);
    expect(isUpdatedSinceRead("2026-02-01T10:00:00.000Z", "2026-02-01T11:00:00.000Z")).toBe(false);
    // Never opened the chat — none of it has been seen.
    expect(isUpdatedSinceRead("2026-02-01T10:00:00.000Z", null)).toBe(true);
    // No write time to compare against cannot be news.
    expect(isUpdatedSinceRead(null, null)).toBe(false);
    expect(isUpdatedSinceRead("not-a-date", null)).toBe(false);
  });

  it("carries the unread flag onto the built summary", () => {
    const summary = buildChatSummary({
      description: "Blocked on the API key.",
      descriptionUpdatedAt: "2026-02-01T12:00:00.000Z",
      lastReadAt: "2026-02-01T09:00:00.000Z",
    });
    expect(summary?.isUnread).toBe(true);
    expect(summary?.updatedAt).toBe("2026-02-01T12:00:00.000Z");
  });

  it("dates the summary in the coarsest unit that still reads", () => {
    const now = Date.parse("2026-02-01T12:00:00.000Z");
    expect(formatSummaryAge(null, now)).toBeNull();
    expect(formatSummaryAge("2026-02-01T11:59:40.000Z", now)).toBe("Updated just now");
    expect(formatSummaryAge("2026-02-01T11:20:00.000Z", now)).toBe("Updated 40m ago");
    expect(formatSummaryAge("2026-02-01T04:00:00.000Z", now)).toBe("Updated 8h ago");
    expect(formatSummaryAge("2026-01-28T12:00:00.000Z", now)).toBe("Updated 4d ago");
  });
});
