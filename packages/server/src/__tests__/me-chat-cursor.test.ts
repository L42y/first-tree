import { describe, expect, it, vi } from "vitest";
import { decodeCursor, encodeCursor } from "../services/me-chat.js";

describe("me-chat encodeCursor / decodeCursor", () => {
  it("round-trips a timestamp + chat id as an `ok` cursor", () => {
    const ts = new Date("2026-05-06T10:24:00.000Z");
    const decoded = decodeCursor(encodeCursor(ts, "chat-123"));
    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") {
      expect(decoded.activityAt.toISOString()).toBe(ts.toISOString());
      expect(decoded.chatId).toBe("chat-123");
    }
  });

  it("emits a versioned payload (v2 prefix)", () => {
    const cursor = encodeCursor(new Date("2026-05-06T10:24:00.000Z"), "chat-123");
    expect(Buffer.from(cursor, "base64url").toString("utf8")).toBe("v2|2026-05-06T10:24:00.000Z|chat-123");
  });

  it("rejects unversioned two-part cursor shapes", () => {
    const withTs = Buffer.from("2026-05-06T10:24:00.000Z|chat-123", "utf8").toString("base64url");
    const emptyTs = Buffer.from("|chat-123", "utf8").toString("base64url");
    expect(decodeCursor(withTs).status).toBe("invalid");
    expect(decodeCursor(emptyTs).status).toBe("invalid");
  });

  it("marks a different version `invalid`", () => {
    const wrongVersion = Buffer.from("v1|2026-05-06T10:24:00.000Z|chat-123", "utf8").toString("base64url");
    expect(decodeCursor(wrongVersion).status).toBe("invalid");
  });

  it("marks a v2 cursor with an empty timestamp or chat id `invalid`", () => {
    expect(decodeCursor(Buffer.from("v2||chat-no-ts", "utf8").toString("base64url")).status).toBe("invalid");
    expect(decodeCursor(Buffer.from("v2|2026-05-06T10:24:00.000Z|", "utf8").toString("base64url")).status).toBe(
      "invalid",
    );
  });

  it("marks malformed cursor strings `invalid`", () => {
    expect(decodeCursor("").status).toBe("invalid");
    expect(decodeCursor(Buffer.from("nosep", "utf8").toString("base64url")).status).toBe("invalid");
    expect(decodeCursor(Buffer.from("not-a-date|chat", "utf8").toString("base64url")).status).toBe("invalid");
    expect(decodeCursor(Buffer.from("v2|not-a-date|chat", "utf8").toString("base64url")).status).toBe("invalid");
  });

  it("marks a cursor `invalid` when base64 decoding throws", () => {
    const spy = vi.spyOn(Buffer, "from").mockImplementationOnce(() => {
      throw new Error("decode failed");
    });
    try {
      expect(decodeCursor("bad-base64").status).toBe("invalid");
    } finally {
      spy.mockRestore();
    }
  });
});
