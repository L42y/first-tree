import { describe, expect, it, vi } from "vitest";
import { createFeishuSenderNameResolver } from "../services/integrations/feishu/sender-name.js";

describe("Feishu sender name resolution", () => {
  it("prefers an event snapshot and never calls Chat Members", async () => {
    const resolver = createFeishuSenderNameResolver();
    const readMembers = vi.fn();
    await expect(
      resolver.resolve({
        botBindingId: "bot-a",
        tenantKey: "tenant-a",
        chatId: "chat-a",
        idType: "open_id",
        id: "ou_a",
        eventName: "Alice",
        readMembers,
      }),
    ).resolves.toBe("Alice");
    expect(readMembers).not.toHaveBeenCalled();
  });

  it("walks every page and caches names by Bot, tenant, id type, and id", async () => {
    const resolver = createFeishuSenderNameResolver();
    const readMembers = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [{ member_id: "ou_other", name: "Other" }], has_more: true, page_token: "p2" },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ member_id_type: "open_id", member_id: "ou_target", name: "Target", tenant_key: "tenant-a" }],
        },
      });
    const input = {
      botBindingId: "bot-a",
      tenantKey: "tenant-a",
      chatId: "chat-a",
      idType: "open_id" as const,
      id: "ou_target",
      readMembers,
    };

    await expect(resolver.resolve(input)).resolves.toBe("Target");
    await expect(resolver.resolve(input)).resolves.toBe("Target");
    expect(readMembers).toHaveBeenCalledTimes(2);
    expect(readMembers).toHaveBeenLastCalledWith({ chatId: "chat-a", idType: "open_id", pageToken: "p2" });

    const otherBindingReader = vi.fn().mockResolvedValue({ data: { items: [] } });
    await expect(resolver.resolve({ ...input, botBindingId: "bot-b", readMembers: otherBindingReader })).resolves.toBe(
      "ou_target",
    );
    expect(otherBindingReader).toHaveBeenCalledOnce();
  });

  it("negative-caches provider failures briefly and clearBinding removes only that Bot's entries", async () => {
    let now = 1_000;
    const resolver = createFeishuSenderNameResolver({ negativeTtlMs: 100, now: () => now });
    const readMembers = vi.fn().mockRejectedValue(new Error("forbidden"));
    const input = {
      botBindingId: "bot-a",
      tenantKey: null,
      chatId: "chat-a",
      idType: "open_id" as const,
      id: "ou_missing",
      readMembers,
    };
    await expect(resolver.resolve(input)).resolves.toBe("ou_missing");
    await expect(resolver.resolve(input)).resolves.toBe("ou_missing");
    expect(readMembers).toHaveBeenCalledOnce();

    now += 101;
    await resolver.resolve(input);
    expect(readMembers).toHaveBeenCalledTimes(2);
    resolver.clearBinding("bot-a");
    await resolver.resolve(input);
    expect(readMembers).toHaveBeenCalledTimes(3);
  });
});
