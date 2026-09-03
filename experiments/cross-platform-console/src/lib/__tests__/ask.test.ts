import type { Message } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";

// ask.ts reaches the network through ./api, which transitively imports
// AsyncStorage; the parsing under test needs none of it.
vi.mock("../api", () => ({ api: vi.fn() }));

const { parseAskRequest } = await import("../ask");

function requestMessage(request: unknown, mentions: string[] = ["agent-1"]): Message {
  return {
    id: "01930000-0000-7000-8000-000000000001",
    chatId: "chat-1",
    senderId: "agent-2",
    format: "request",
    content: "Which option should we take?",
    metadata: { request, mentions },
  } as unknown as Message;
}

const option = (label: string) => ({ label, description: "why this option" });

describe("parseAskRequest", () => {
  it("keeps a conforming option list", () => {
    const parsed = parseAskRequest(requestMessage({ options: [option("Ship it"), option("Wait")] }));
    expect(parsed?.request.options).toHaveLength(2);
    expect(parsed?.request.multiSelect).toBe(false);
    expect(parsed?.targetAgentId).toBe("agent-1");
  });

  it("still surfaces the ask when the payload is absent", () => {
    const parsed = parseAskRequest(requestMessage(undefined));
    expect(parsed).not.toBeNull();
    expect(parsed?.request.options).toBeUndefined();
  });

  // The regression this file exists for: a schema-invalid affordance used to
  // yield null, and both call sites read null as "not an ask", so a question
  // the server reported as open rendered no dock at all.
  it("salvages the first four options when the list is too long", () => {
    const parsed = parseAskRequest(
      requestMessage({
        options: [option("One"), option("Two"), option("Three"), option("Four"), option("Five")],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.request.options).toHaveLength(4);
    expect(parsed?.request.options?.[0]?.label).toBe("One");
  });

  it("degrades to a free-text ask when an option is malformed", () => {
    const parsed = parseAskRequest(
      requestMessage({
        options: [{ label: "this label is far too many words to pass", description: "d" }, option("Fine")],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.request.options).toBeUndefined();
    expect(parsed?.request.multiSelect).toBe(false);
  });

  it("degrades rather than vanishing when a description is missing", () => {
    const parsed = parseAskRequest(requestMessage({ options: [{ label: "Yes" }, { label: "No" }] }));
    expect(parsed).not.toBeNull();
    expect(parsed?.request.options).toBeUndefined();
  });

  it("returns null only for a non-request message", () => {
    const message = { ...requestMessage({}), format: "text" } as unknown as Message;
    expect(parseAskRequest(message)).toBeNull();
  });
});
