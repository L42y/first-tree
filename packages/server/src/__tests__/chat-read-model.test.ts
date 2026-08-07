import { describe, expect, it } from "vitest";
import { CHAT_SUMMARY_MAX_LENGTH, extractChatSummary, resolveChatTitle } from "../services/chat-read-model.js";

describe("extractChatSummary", () => {
  it("extracts text from JSONB content and string content", () => {
    expect(extractChatSummary({ text: "JSONB message" })).toBe("JSONB message");
    expect(extractChatSummary("String message")).toBe("String message");
  });

  it("returns null when content has no text", () => {
    expect(extractChatSummary({ format: "card" })).toBeNull();
    expect(extractChatSummary({ text: null })).toBeNull();
  });

  it("removes real mentions and collapses surrounding whitespace", () => {
    expect(extractChatSummary("  Hello   @agent-01\n\tplease   review  ")).toBe("Hello please review");
  });

  it("protects code-region tokens from partial mention removal", () => {
    expect(extractChatSummary("Use `@param` decorator, then ask @reviewer")).toBe("Use decorator, then ask");
  });

  it("returns null for mention-only or whitespace-only content", () => {
    expect(extractChatSummary("  @agent-01\n @agent-02  ")).toBeNull();
    expect(extractChatSummary(" \n\t ")).toBeNull();
  });

  it("uses a custom maximum length", () => {
    expect(extractChatSummary("abcdef", 4)).toBe("abcd");
  });

  it("defaults to the exported maximum length", () => {
    const text = "a".repeat(CHAT_SUMMARY_MAX_LENGTH + 5);
    expect(extractChatSummary(text)).toBe("a".repeat(CHAT_SUMMARY_MAX_LENGTH));
  });

  it("truncates by Unicode code point without splitting emoji", () => {
    expect(extractChatSummary("😀😀x", 2)).toBe("😀😀");
  });
});

describe("resolveChatTitle", () => {
  const me = "agent-self";

  it("prefers chat.topic when present", () => {
    expect(resolveChatTitle("Fix homepage", null, [], me)).toBe("Fix homepage");
  });

  it("uses first-message summary when topic is empty", () => {
    expect(
      resolveChatTitle(
        null,
        "请帮我重构这个文件",
        [
          { agentId: me, displayName: "Me" },
          { agentId: "a", displayName: "Code Agent" },
        ],
        me,
      ),
    ).toBe("请帮我重构这个文件");
  });

  it("lets topic outrank first-message summary", () => {
    expect(resolveChatTitle("Manual Title", "First message", [{ agentId: "a", displayName: "Code Agent" }], me)).toBe(
      "Manual Title",
    );
  });

  it("falls back to comma-joined participant display names for up to three others", () => {
    expect(
      resolveChatTitle(
        null,
        null,
        [
          { agentId: me, displayName: "Me" },
          { agentId: "a", displayName: "Code Agent" },
          { agentId: "b", displayName: "Design Agent" },
        ],
        me,
      ),
    ).toBe("Code Agent, Design Agent");
  });

  it("collapses to +N for four or more other participants", () => {
    expect(
      resolveChatTitle(
        null,
        null,
        [
          { agentId: me, displayName: "Me" },
          { agentId: "a", displayName: "Alice" },
          { agentId: "b", displayName: "Bob" },
          { agentId: "c", displayName: "Carol" },
          { agentId: "d", displayName: "Dave" },
        ],
        me,
      ),
    ).toBe("Alice, Bob +2");
  });

  it("returns a sentinel when no other participants exist", () => {
    expect(resolveChatTitle(null, null, [{ agentId: me, displayName: "Me" }], me)).toBe("Empty chat");
  });

  it("ignores empty topic strings", () => {
    expect(
      resolveChatTitle(
        "",
        null,
        [
          { agentId: me, displayName: "Me" },
          { agentId: "a", displayName: "Code Agent" },
        ],
        me,
      ),
    ).toBe("Code Agent");
  });
});
