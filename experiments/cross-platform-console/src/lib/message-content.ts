import type { Message } from "@first-tree/shared";
import { extractCaption, type ImageRefContent, isImageBatchRefContent, isImageRefContent } from "@first-tree/shared";

export type InlineImageContent = {
  data: string;
  mimeType: string;
};

export function isInlineImageContent(content: unknown): content is InlineImageContent {
  if (typeof content !== "object" || content === null) return false;
  const value = content as Record<string, unknown>;
  return typeof value.data === "string" && typeof value.mimeType === "string" && value.mimeType.startsWith("image/");
}

/** Normalize the image-reference shapes used by `format: "file"` messages. */
export function messageImageAttachments(message: Message): {
  caption: string;
  images: ImageRefContent[];
} {
  if (message.format !== "file") return { caption: "", images: [] };
  const { content } = message;
  if (isImageRefContent(content)) return { caption: "", images: [content] };
  if (isImageBatchRefContent(content)) return { caption: extractCaption(content), images: content.attachments };
  return { caption: "", images: [] };
}

export function messageInlineImage(message: Message): InlineImageContent | null {
  return message.format === "file" && isInlineImageContent(message.content) ? message.content : null;
}
