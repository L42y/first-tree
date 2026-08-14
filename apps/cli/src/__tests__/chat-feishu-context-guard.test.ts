import type { ChatExternalChannel } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import {
  checkFeishuChatContext,
  FEISHU_CHAT_CONTEXT_CODE,
  feishuChatContextMessage,
  isFeishuBridgedChatContext,
} from "../core/feishu-chat-context.js";

/**
 * Pins the two CLI-side preconditions the server cannot enforce.
 *
 * `chat create` never transmits the originating chat (`createTaskChatSchema`
 * has no field for it, and there is no header), and `chat open` runs on the
 * user scope and starts an interactive REPL. Both are therefore refused here,
 * from `FIRST_TREE_CHAT_ID` plus the live `externalChannel` signal — and both
 * must fail OPEN, because the real boundary lives on the server routes that
 * do carry a chat id.
 */

type DetailRow = { externalChannel?: ChatExternalChannel | null };

function reader(impl: () => Promise<DetailRow>) {
  return { getChatDetail: vi.fn(impl) };
}

describe("isFeishuBridgedChatContext", () => {
  it("reports a bridged chat", async () => {
    const sdk = reader(async () => ({ externalChannel: "feishu" }));
    expect(await isFeishuBridgedChatContext(sdk, "chat-1")).toBe(true);
    expect(sdk.getChatDetail).toHaveBeenCalledWith("chat-1");
  });

  it("reports an ordinary chat", async () => {
    expect(
      await isFeishuBridgedChatContext(
        reader(async () => ({ externalChannel: null })),
        "chat-1",
      ),
    ).toBe(false);
  });

  it("treats a server that predates the field as unbridged", async () => {
    expect(
      await isFeishuBridgedChatContext(
        reader(async () => ({})),
        "chat-1",
      ),
    ).toBe(false);
  });

  it("fails open when the lookup throws — the server stays the boundary", async () => {
    const sdk = reader(async () => {
      throw new Error("connection refused");
    });
    expect(await isFeishuBridgedChatContext(sdk, "chat-1")).toBe(false);
  });
});

describe("checkFeishuChatContext", () => {
  it("refuses `chat create` inside a bridged chat and names the Feishu path", async () => {
    const refusal = await checkFeishuChatContext(
      reader(async () => ({ externalChannel: "feishu" })),
      "chat-1",
      "create",
    );
    expect(refusal?.code).toBe(FEISHU_CHAT_CONTEXT_CODE);
    expect(refusal?.message).toContain("chat create");
    expect(refusal?.message).toContain("feishu intent");
    expect(refusal?.message).toContain("lark-cli");
  });

  it("refuses `chat open` inside a bridged chat", async () => {
    const refusal = await checkFeishuChatContext(
      reader(async () => ({ externalChannel: "feishu" })),
      "chat-1",
      "open",
    );
    expect(refusal?.code).toBe(FEISHU_CHAT_CONTEXT_CODE);
    expect(refusal?.message).toContain("chat open");
    expect(refusal?.message).toContain("feishu intent");
  });

  it("allows both commands in an ordinary chat", async () => {
    for (const command of ["create", "open"] as const) {
      expect(
        await checkFeishuChatContext(
          reader(async () => ({ externalChannel: null })),
          "chat-1",
          command,
        ),
      ).toBeNull();
    }
  });

  it("skips the lookup entirely outside an agent session", async () => {
    const sdk = reader(async () => ({ externalChannel: "feishu" }));
    expect(await checkFeishuChatContext(sdk, undefined, "create")).toBeNull();
    expect(sdk.getChatDetail).not.toHaveBeenCalled();
  });
});

describe("feishuChatContextMessage", () => {
  it("explains why each command is wrong here, not just that it is refused", () => {
    expect(feishuChatContextMessage("create")).toContain("nobody in the Feishu group can see");
    expect(feishuChatContextMessage("open")).toContain("interactive REPL");
  });
});
