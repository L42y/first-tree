import type { Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";

import { messageImageAttachments, messageInlineImage } from "../message-content";

const image = {
  imageId: "5c9d7fa5-6bd0-4a8f-b3ec-570e857934f3",
  mimeType: "image/png",
  filename: "qr.png",
};

function message(content: unknown, format = "file"): Message {
  return {
    id: "message-1",
    chatId: "chat-1",
    senderId: "agent-1",
    senderKind: "member",
    senderProvider: null,
    format,
    content,
    metadata: {},
    inReplyTo: null,
    source: "api",
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("message image content", () => {
  it("renders a standalone referenced image", () => {
    const result = messageImageAttachments(message(image));
    expect(result).toEqual({ caption: "", images: [image] });
  });

  it("renders a caption with a referenced image batch", () => {
    const result = messageImageAttachments(message({ caption: "Scan here", attachments: [image] }));
    expect(result).toEqual({ caption: "Scan here", images: [image] });
  });

  it("supports inline data images and ignores non-file messages", () => {
    const inline = { data: "data:image/png;base64,abc", mimeType: "image/png" };
    expect(messageInlineImage(message(inline))).toEqual(inline);
    expect(messageImageAttachments(message("plain text", "markdown")).images).toEqual([]);
  });
});
