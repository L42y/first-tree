import { describe, expect, it } from "vitest";
import {
  askAgentMessageMetadataSchema,
  askAgentQuestionSchema,
  askOptionSchema,
  askRequestSchema,
  readAskAgentMessageMetadata,
} from "../schemas/message.js";

const OPT = { label: "Ship", description: "ship now" };

describe("askOptionSchema", () => {
  it("accepts a 1–5 word label with a description", () => {
    expect(askOptionSchema.safeParse({ label: "Ship", description: "d" }).success).toBe(true);
    expect(askOptionSchema.safeParse({ label: "one two three four five", description: "d" }).success).toBe(true);
  });

  it("rejects a label of more than 5 words", () => {
    expect(askOptionSchema.safeParse({ label: "one two three four five six", description: "d" }).success).toBe(false);
  });

  it("rejects an empty/whitespace label or a missing description", () => {
    expect(askOptionSchema.safeParse({ label: "", description: "d" }).success).toBe(false);
    expect(askOptionSchema.safeParse({ label: "   ", description: "d" }).success).toBe(false);
    expect(askOptionSchema.safeParse({ label: "Ship", description: "" }).success).toBe(false);
    expect(askOptionSchema.safeParse({ label: "Ship" }).success).toBe(false);
  });

  it("keeps an optional preview and omits it when absent", () => {
    expect(askOptionSchema.parse({ label: "Ship", description: "d", preview: "code" }).preview).toBe("code");
    expect("preview" in askOptionSchema.parse({ label: "Ship", description: "d" })).toBe(false);
  });
});

describe("askRequestSchema", () => {
  it("parses a free-text ask (no options) and defaults multiSelect to false", () => {
    expect(askRequestSchema.parse({})).toEqual({ multiSelect: false });
  });

  it("accepts 2–4 options", () => {
    expect(askRequestSchema.safeParse({ options: [OPT, OPT] }).success).toBe(true);
    expect(askRequestSchema.safeParse({ options: [OPT, OPT, OPT, OPT] }).success).toBe(true);
  });

  it("rejects fewer than 2 or more than 4 options", () => {
    expect(askRequestSchema.safeParse({ options: [OPT] }).success).toBe(false);
    expect(askRequestSchema.safeParse({ options: [OPT, OPT, OPT, OPT, OPT] }).success).toBe(false);
  });

  it("rejects multiSelect without options, allows it with options", () => {
    expect(askRequestSchema.safeParse({ multiSelect: true }).success).toBe(false);
    expect(askRequestSchema.safeParse({ options: [OPT, OPT], multiSelect: true }).success).toBe(true);
  });
});

describe("Ask agent schemas", () => {
  it("accepts a bounded visible question and trims it", () => {
    expect(askAgentQuestionSchema.parse({ content: "  Explain option B.  " })).toEqual({
      content: "Explain option B.",
    });
    expect(askAgentQuestionSchema.safeParse({ content: " " }).success).toBe(false);
  });

  it("reads only a complete trusted marker shape", () => {
    const marker = { requestId: "request-1", agentId: "agent-1" };
    expect(askAgentMessageMetadataSchema.parse(marker)).toEqual(marker);
    expect(readAskAgentMessageMetadata({ askAgent: marker })).toEqual(marker);
    expect(readAskAgentMessageMetadata({ askAgent: { requestId: "request-1" } })).toBeNull();
  });
});
