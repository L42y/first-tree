import { afterEach, describe, expect, it, vi } from "vitest";
import { readFeishuParentMessage } from "../services/integrations/feishu/provider-reader.js";

describe("Feishu provider reader", () => {
  afterEach(() => vi.useRealTimers());

  it("preserves the Bot open id when the standard sender id is an App id", async () => {
    const request = vi.fn().mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        items: [
          {
            chat_id: "oc_group",
            sender: {
              id: "cli_current_app",
              id_type: "app_id",
              sender_type: "app",
              open_bot_id: "ou_current_bot",
            },
          },
        ],
      },
    });

    await expect(readFeishuParentMessage({ request } as never, "om_parent", 1_000)).resolves.toEqual({
      chatId: "oc_group",
      sender: {
        id: "cli_current_app",
        idType: "app_id",
        senderType: "app",
        openBotId: "ou_current_bot",
      },
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/im/v1/messages/om_parent",
        signal: expect.any(AbortSignal),
        timeout: 1_000,
      }),
    );
  });

  it("aborts the underlying parent request when its admission timeout expires", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const request = vi.fn().mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          receivedSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
        }),
    );

    const pending = readFeishuParentMessage({ request } as never, "om_parent", 50);
    const rejection = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(receivedSignal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
