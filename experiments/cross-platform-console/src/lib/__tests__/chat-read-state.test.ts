import { describe, expect, it } from "vitest";

import {
  countUnreadMessages,
  findFirstUnreadIndex,
  flattenNewestFirstMessages,
  formatNewMessages,
  isAtNewestEdge,
} from "../chat-read-state";

describe("chat read state", () => {
  const newestFirst = [
    { id: "d", senderId: "agent" },
    { id: "c", senderId: "me" },
    { id: "b", senderId: "agent" },
    { id: "a", senderId: "agent" },
  ];

  it("reverses newest-first server pages into display order", () => {
    expect(
      flattenNewestFirstMessages([
        [newestFirst[2], newestFirst[3]],
        [newestFirst[0], newestFirst[1]],
      ]),
    ).toEqual([newestFirst[1], newestFirst[0], newestFirst[3], newestFirst[2]]);
  });

  it("counts timeline-newer non-self messages without comparing random IDs lexically", () => {
    const chronological = [...newestFirst].reverse();
    expect(countUnreadMessages(chronological, "a", ["me"])).toBe(2);
    expect(countUnreadMessages(chronological, "z-missing", ["me"])).toBe(0);
  });

  it("places the divider on the first timeline-newer non-self row", () => {
    const chronological = [...newestFirst].reverse();
    expect(findFirstUnreadIndex(chronological, "a", ["me"])).toBe(1);
    expect(findFirstUnreadIndex(chronological, null, ["me"])).toBe(-1);
  });

  it("formats the exact web labels", () => {
    expect(formatNewMessages(0)).toBeNull();
    expect(formatNewMessages(1)).toBe("1 new message");
    expect(formatNewMessages(3)).toBe("3 new messages");
  });

  it("treats the newest edge of the inverted timeline as read", () => {
    // Inverted list: offset 0 is the newest message at the bottom of the screen.
    expect(isAtNewestEdge(0)).toBe(true);
    // Within the slack — the last few pixels of rubber-band still count.
    expect(isAtNewestEdge(20)).toBe(true);
    // Scrolled up into history: newer messages are below the fold.
    expect(isAtNewestEdge(400)).toBe(false);
  });
});
