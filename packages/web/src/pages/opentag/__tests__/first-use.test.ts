import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_USE_MAX_PAGES, FIRST_USE_PAGE_SIZE, isFeishuTaskForBinding, readOpenTagFirstUse } from "../first-use.js";

const AGENT_UUID = "0198b2c4-1f6a-7c31-9a02-4d5e6f708192";
const BINDING = "binding-1";

const meChats = vi.hoisted(() => ({ listMeChats: vi.fn() }));
vi.mock("../../../api/me-chats.js", () => meChats);

const chats = vi.hoisted(() => ({ getChat: vi.fn() }));
vi.mock("../../../api/chats.js", () => chats);

/** Only the fields this read consumes; the real rows carry far more. */
function page(chatIds: string[], nextCursor: string | null = null) {
  return { priorityRows: { pinned: [] }, rows: chatIds.map((chatId) => ({ chatId })), nextCursor };
}

function feishuChat(botBindingId: string, externalChatId = "oc_1") {
  return {
    metadata: { source: "feishu", botBindingId, externalChatId, externalChatType: "p2p" },
  };
}

beforeEach(() => {
  meChats.listMeChats.mockReset();
  chats.getChat.mockReset();
});

describe("isFeishuTaskForBinding", () => {
  it("accepts only this Agent's own Bot binding", () => {
    expect(isFeishuTaskForBinding(feishuChat(BINDING).metadata, BINDING)).toBe(true);
    // The same external Feishu chat reached through another Bot is a different
    // Task belonging to a different Agent — never this member's first use.
    expect(isFeishuTaskForBinding(feishuChat("binding-2").metadata, BINDING)).toBe(false);
  });

  it("rejects anything that is not a Feishu Task", () => {
    expect(isFeishuTaskForBinding({ source: "agent" }, BINDING)).toBe(false);
    expect(isFeishuTaskForBinding({ source: "github", entityType: "issue", entityKey: "o/r#1" }, BINDING)).toBe(false);
    // An ordinary chat carries no metadata at all.
    expect(isFeishuTaskForBinding({}, BINDING)).toBe(false);
    expect(isFeishuTaskForBinding(null, BINDING)).toBe(false);
    // A malformed row must not be read as a match by coincidence.
    expect(isFeishuTaskForBinding({ source: "feishu", botBindingId: BINDING }, BINDING)).toBe(false);
  });
});

describe("readOpenTagFirstUse", () => {
  it("asks only for this Agent's Feishu chats, archived ones included", async () => {
    meChats.listMeChats.mockResolvedValue(page([]));

    expect(await readOpenTagFirstUse(AGENT_UUID, BINDING)).toEqual({ state: "absent" });
    expect(meChats.listMeChats).toHaveBeenCalledWith({
      origin: ["feishu"],
      with: [AGENT_UUID],
      engagement: "all",
      limit: FIRST_USE_PAGE_SIZE,
    });
    expect(chats.getChat).not.toHaveBeenCalled();
  });

  it("follows the cursor to a Task that is no longer recently active", async () => {
    // The conversation list is ordered by activity, not relevance. A member who
    // used their Agent a while ago, and has since collaborated in busier Feishu
    // conversations, has their own Task pushed off the first page — and every
    // poll would re-read that same page and reach the same wrong conclusion.
    meChats.listMeChats
      .mockResolvedValueOnce(page(["chat-busy"], "cursor-1"))
      .mockResolvedValueOnce(page(["chat-mine"]));
    chats.getChat.mockImplementation(async (chatId: string) =>
      chatId === "chat-mine" ? feishuChat(BINDING) : feishuChat("binding-2"),
    );

    expect(await readOpenTagFirstUse(AGENT_UUID, BINDING)).toEqual({ state: "present", chatId: "chat-mine" });
    expect(meChats.listMeChats).toHaveBeenCalledTimes(2);
    expect(meChats.listMeChats.mock.calls[1]?.[0]).toMatchObject({ cursor: "cursor-1" });
  });

  it("does not call a partially read list an absence", async () => {
    // Reporting `absent` here would strand a member who really did use their
    // Agent. `unknown` keeps the poll going instead of concluding from a page
    // that was never finished.
    meChats.listMeChats.mockResolvedValue(page(["chat-other"], "cursor-forever"));
    chats.getChat.mockResolvedValue(feishuChat("binding-2"));

    expect(await readOpenTagFirstUse(AGENT_UUID, BINDING)).toEqual({ state: "unknown" });
    expect(meChats.listMeChats).toHaveBeenCalledTimes(FIRST_USE_MAX_PAGES);
  });

  it("reports the Task chat once this Agent's Bot has one", async () => {
    meChats.listMeChats.mockResolvedValue(page(["chat-1"]));
    chats.getChat.mockResolvedValue(feishuChat(BINDING));

    expect(await readOpenTagFirstUse(AGENT_UUID, BINDING)).toEqual({ state: "present", chatId: "chat-1" });
  });

  it("does not accept a teammate's Feishu Task this Agent was invited into", async () => {
    // The participant filter alone would match: an internal collaborator is a
    // speaker in a Feishu-origin chat. The Bot binding is what tells the two
    // apart, and it belongs to the other Agent.
    meChats.listMeChats.mockResolvedValue(page(["chat-neighbour"]));
    chats.getChat.mockResolvedValue(feishuChat("binding-2"));

    expect(await readOpenTagFirstUse(AGENT_UUID, BINDING)).toEqual({ state: "absent" });
  });

  it("finds this Agent's own Task past a neighbour's", async () => {
    meChats.listMeChats.mockResolvedValue(page(["chat-neighbour", "chat-mine"]));
    chats.getChat.mockImplementation(async (chatId: string) =>
      chatId === "chat-mine" ? feishuChat(BINDING) : feishuChat("binding-2"),
    );

    expect(await readOpenTagFirstUse(AGENT_UUID, BINDING)).toEqual({ state: "present", chatId: "chat-mine" });
  });

  it("propagates a failed read instead of reporting no first use", async () => {
    meChats.listMeChats.mockRejectedValue(new Error("offline"));
    await expect(readOpenTagFirstUse(AGENT_UUID, BINDING)).rejects.toThrow("offline");

    meChats.listMeChats.mockResolvedValue(page(["chat-1"]));
    chats.getChat.mockRejectedValue(new Error("offline"));
    await expect(readOpenTagFirstUse(AGENT_UUID, BINDING)).rejects.toThrow("offline");
  });
});
