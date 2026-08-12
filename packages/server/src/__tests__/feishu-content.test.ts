import { describe, expect, it } from "vitest";
import { convertFeishuContent } from "../services/integrations/feishu/content.js";

describe("Feishu content normalization", () => {
  it("uses structured mentions, strips the addressed Bot, and avoids prefix collisions", () => {
    const result = convertFeishuContent({
      messageType: "text",
      rawContent: JSON.stringify({ text: "@_user_1 @_user_10 @_user_2 hello" }),
      mentions: [
        { key: "@_user_1", openId: "ou_1", name: "Alice" },
        { key: "@_user_10", openId: "ou_10", name: "Charlie" },
        { key: "@_user_2", openId: "ou_bot", name: "Bot", isBot: true },
      ],
    });

    expect(result.content).toBe("@Alice @Charlie hello");
    expect(result.mentions).toHaveLength(3);
  });

  it("renders localized post elements and returns typed resource descriptors", () => {
    const result = convertFeishuContent({
      messageType: "post",
      rawContent: JSON.stringify({
        zh_cn: {
          title: "发布 <提醒>",
          content: [
            [
              { tag: "text", text: "important", style: ["bold", "italic"] },
              { tag: "a", text: " docs", href: "https://example.com/a(b)" },
            ],
            [{ tag: "text", text: "path\\`tick", style: ["codeInline"] }],
            [{ tag: "code_block", language: "ts<script>", text: "const x = `safe`;" }],
            [
              { tag: "img", image_key: "img_post" },
              { tag: "media", file_key: "file_post", file_name: "a.pdf" },
            ],
            [{ tag: "hr" }, { tag: "emotion", emoji_type: "SMILE" }],
          ],
        },
      }),
    });

    expect(result.content).toContain("**发布 \\<提醒\\>**");
    expect(result.content).toContain("***important***");
    expect(result.content).toContain("[ docs](https://example.com/a%28b%29)");
    const inlineCode = result.content.split("\n").find((line) => line.startsWith("`path"));
    expect(inlineCode).toMatch(/^`path/);
    expect(inlineCode).toMatch(/tick`$/);
    expect(inlineCode?.match(/\\/g)?.length).toBeGreaterThan(1);
    expect(result.content).toContain("```tsscript");
    expect(result.resources).toEqual([
      { type: "image", fileKey: "img_post", origin: "post" },
      { type: "file", fileKey: "file_post", fileName: "a.pdf", origin: "post" },
    ]);
  });

  it.each([
    ["image", { image_key: "img_1" }, "image", "img_1"],
    ["file", { file_key: "file_1", file_name: "report.pdf" }, "file", "file_1"],
    ["audio", { file_key: "audio_1", duration: 3_000 }, "audio", "audio_1"],
    ["media", { file_key: "video_1", image_key: "cover_1", duration: 5_000 }, "video", "video_1"],
    ["sticker", { file_key: "sticker_1" }, "sticker", "sticker_1"],
  ] as const)("normalizes %s messages", (messageType, raw, expectedType, expectedKey) => {
    const result = convertFeishuContent({ messageType, rawContent: JSON.stringify(raw) });
    expect(result.resources[0]).toMatchObject({ type: expectedType, fileKey: expectedKey });
    if (messageType === "media") {
      expect(result.resources[1]).toEqual({ type: "image", fileKey: "cover_1", origin: "message" });
    }
  });

  it("degrades cards, merged forwards, unknown schemes, and malformed content without executing markup", () => {
    const card = convertFeishuContent({
      messageType: "interactive",
      rawContent: JSON.stringify({
        elements: [
          { tag: "lark_md", content: "<at id=all>everyone</at> <scr<script>ipt>alert(1)</script> **run**" },
          { tag: "img", img_key: "card_img" },
        ],
      }),
    });
    expect(card.content).toContain("\\<at id=all\\>everyone\\</at\\>");
    expect(card.content).not.toContain("<script>");
    expect(card.content).toContain("\\<scr\\<script\\>ipt\\>");
    expect(card.content).toContain("\\*\\*run\\*\\*");
    expect(card.resources[0]).toMatchObject({ fileKey: "card_img", origin: "interactive" });

    expect(convertFeishuContent({ messageType: "merge_forward", rawContent: "{}" }).content).toContain("无法可靠展开");
    expect(convertFeishuContent({ messageType: "post", rawContent: "not-json" }).content).toContain("无法解析");
    expect(
      convertFeishuContent({
        messageType: "post",
        rawContent: JSON.stringify({ content: [[{ tag: "a", text: "unsafe", href: "javascript:alert(1)" }]] }),
      }).content,
    ).toBe("unsafe");
  });
});
