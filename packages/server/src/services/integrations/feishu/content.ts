import type { FeishuMention } from "@first-tree/shared";

export type FeishuResourceDescriptor = {
  type: "image" | "file" | "audio" | "video" | "sticker";
  fileKey: string;
  fileName?: string;
  durationMs?: number;
  coverImageKey?: string;
  origin: "message" | "post" | "interactive" | "merge_forward";
};

export type FeishuContentResult = {
  content: string;
  mentions: FeishuMention[];
  resources: FeishuResourceDescriptor[];
};

export type FeishuContentInput = {
  messageType: string;
  rawContent: string;
  fallbackContent?: string;
  mentions?: readonly {
    key: string;
    openId?: string;
    userId?: string;
    name?: string;
    isBot?: boolean;
  }[];
};

type JsonRecord = Record<string, unknown>;

/**
 * Convert provider content into inert Markdown plus typed resource references.
 * Routing never reads the returned text; exact Bot mentions are taken from the
 * signed event's structured mention array before this converter runs.
 */
export function convertFeishuContent(input: FeishuContentInput): FeishuContentResult {
  const mentions = normalizeMentions(input.mentions);
  const context: RenderContext = {
    mentionsByKey: new Map(mentions.map((mention) => [mention.key, mention])),
    mentionsById: new Map(
      mentions.flatMap((mention) => {
        const ids = [mention.openId, mention.userId].filter((id): id is string => Boolean(id));
        return ids.map((id) => [id, mention] as const);
      }),
    ),
    resources: [],
  };

  try {
    const parsed = safeParse(input.rawContent);
    const rendered = renderMessage(input.messageType, parsed, input.rawContent, context);
    return {
      content: resolveMentionPlaceholders(rendered || input.fallbackContent || "（空消息）", context),
      mentions,
      resources: dedupeResources(context.resources),
    };
  } catch {
    return {
      content: fallbackFor(input.messageType, input.fallbackContent),
      mentions,
      resources: [],
    };
  }
}

type RenderContext = {
  mentionsByKey: Map<string, FeishuMention>;
  mentionsById: Map<string, FeishuMention>;
  resources: FeishuResourceDescriptor[];
};

function normalizeMentions(input: FeishuContentInput["mentions"]): FeishuMention[] {
  const result: FeishuMention[] = [];
  for (const mention of input ?? []) {
    if (!mention.key) continue;
    result.push({
      key: mention.key,
      openId: mention.openId ?? null,
      userId: mention.userId ?? null,
      name: mention.name?.trim() || null,
      isBot: mention.isBot === true,
    });
  }
  return result;
}

function renderMessage(type: string, parsed: unknown, raw: string, context: RenderContext): string {
  const record = asRecord(parsed);
  switch (type) {
    case "text":
      return readString(record, "text") ?? raw;
    case "post":
      return renderPost(record, context);
    case "image":
      return renderResource(record, context, "image", "图片");
    case "file":
      return renderResource(record, context, "file", "文件");
    case "audio":
      return renderResource(record, context, "audio", "音频");
    case "video":
    case "media":
      return renderResource(record, context, "video", "视频");
    case "sticker":
      return renderResource(record, context, "sticker", "表情包");
    case "interactive":
      return renderInteractive(record, context);
    case "merge_forward":
      return "[合并转发消息：当前无法可靠展开子消息]";
    default:
      return readString(record, "text") ?? fallbackFor(type);
  }
}

function renderResource(
  record: JsonRecord | null,
  context: RenderContext,
  type: FeishuResourceDescriptor["type"],
  label: string,
): string {
  const fileKey = readString(record, type === "image" ? "image_key" : "file_key");
  if (!fileKey) return `[${label}：资源引用缺失]`;
  const fileName = safeFilename(readString(record, "file_name"));
  const durationMs = readNonNegativeInteger(record, "duration");
  const coverImageKey = readString(record, "image_key");
  context.resources.push({
    type,
    fileKey,
    ...(fileName ? { fileName } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(type === "video" && coverImageKey ? { coverImageKey } : {}),
    origin: "message",
  });
  if (type === "video" && coverImageKey) {
    context.resources.push({ type: "image", fileKey: coverImageKey, origin: "message" });
  }
  const details = [fileName, durationMs !== undefined ? formatDuration(durationMs) : null].filter(Boolean).join("，");
  return `[${label}${details ? `：${escapeInline(details)}` : ""}]`;
}

function renderPost(record: JsonRecord | null, context: RenderContext): string {
  const body = unwrapLocale(record);
  if (!body) return "[富文本消息：内容无法解析]";
  const lines: string[] = [];
  const title = readString(body, "title");
  if (title) lines.push(`**${escapeInline(title)}**`, "");
  const paragraphs = Array.isArray(body.content) ? body.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    lines.push(paragraph.map((element) => renderPostElement(asRecord(element), context)).join(""));
  }
  return lines.join("\n").trim() || "[富文本消息：无可读内容]";
}

function renderPostElement(element: JsonRecord | null, context: RenderContext): string {
  if (!element) return "";
  const tag = readString(element, "tag") ?? "";
  switch (tag) {
    case "text":
      return applyStyle(escapeInline(readString(element, "text") ?? ""), element.style);
    case "a": {
      const label = escapeInline(readString(element, "text") ?? readString(element, "href") ?? "链接");
      const href = safeLink(readString(element, "href"));
      return href ? `[${label}](${href})` : label;
    }
    case "at": {
      const id = readString(element, "user_id") ?? "";
      if (id === "all" || id === "all_members") return "@all";
      const mention = context.mentionsById.get(id);
      return mention?.key ?? `@${escapeInline(readString(element, "user_name") ?? id)}`;
    }
    case "img": {
      const fileKey = readString(element, "image_key");
      if (!fileKey) return "[图片：资源引用缺失]";
      context.resources.push({ type: "image", fileKey, origin: "post" });
      return "[图片]";
    }
    case "media": {
      const fileKey = readString(element, "file_key");
      if (!fileKey) return "[媒体：资源引用缺失]";
      const fileName = safeFilename(readString(element, "file_name"));
      context.resources.push({ type: "file", fileKey, ...(fileName ? { fileName } : {}), origin: "post" });
      return fileName ? `[文件：${escapeInline(fileName)}]` : "[文件]";
    }
    case "code_block":
      return renderCodeBlock(readString(element, "text") ?? "", readString(element, "language") ?? "");
    case "hr":
      return "\n\n---\n\n";
    case "emotion":
      return `[${escapeInline(readString(element, "emoji_type") ?? "表情")}]`;
    default:
      return escapeInline(readString(element, "text") ?? "");
  }
}

function renderInteractive(record: JsonRecord | null, context: RenderContext): string {
  if (!record) return "[飞书卡片：内容无法解析]";
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    const node = asRecord(value);
    if (!node) return;
    const tag = readString(node, "tag");
    if (tag === "plain_text" || tag === "lark_md" || tag === "markdown") {
      const content = readString(node, "content");
      if (content) parts.push(escapeCardMarkdown(content));
      return;
    }
    if (tag === "img") {
      const fileKey = readString(node, "img_key");
      if (fileKey) context.resources.push({ type: "image", fileKey, origin: "interactive" });
      parts.push("[卡片图片：飞书不支持通过消息资源接口下载]");
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (["value", "behaviors", "fallback", "config"].includes(key)) continue;
      walk(child);
    }
  };
  walk(record);
  const readable = adjacentUnique(parts).join("\n\n").trim();
  return readable ? `[飞书卡片（部分内容）]\n\n${readable}` : "[飞书卡片：当前无法可靠展开 Card 2.0 内容]";
}

function resolveMentionPlaceholders(content: string, context: RenderContext): string {
  let result = content;
  const mentions = [...context.mentionsByKey.values()].sort((a, b) => b.key.length - a.key.length);
  for (const mention of mentions) {
    const replacement = mention.isBot
      ? ""
      : `@${escapeInline(mention.name || mention.openId || mention.userId || "未知用户")}`;
    result = result.split(mention.key).join(replacement);
  }
  return (
    result
      .replace(/@_user_\d+/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim() || "（空消息）"
  );
}

function dedupeResources(resources: FeishuResourceDescriptor[]): FeishuResourceDescriptor[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.type}:${resource.fileKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyStyle(text: string, value: unknown): string {
  const styles = new Set<string>();
  if (Array.isArray(value)) for (const style of value) if (typeof style === "string") styles.add(style);
  const record = asRecord(value);
  if (record) for (const [style, enabled] of Object.entries(record)) if (enabled === true) styles.add(style);
  let result = text;
  if (styles.has("bold")) result = `**${result}**`;
  if (styles.has("italic")) result = `*${result}*`;
  if (styles.has("underline")) result = `<u>${result}</u>`;
  if (styles.has("lineThrough") || styles.has("strikethrough")) result = `~~${result}~~`;
  if (styles.has("codeInline") || styles.has("code")) result = `\`${result.replace(/([\\`])/g, "\\$1")}\``;
  return result;
}

function renderCodeBlock(text: string, language: string): string {
  const fence = text.includes("````") ? "`````" : text.includes("```") ? "````" : "```";
  const safeLanguage = language.replace(/[^a-zA-Z0-9_+.-]/g, "").slice(0, 40);
  return `\n${fence}${safeLanguage}\n${text}\n${fence}\n`;
}

function unwrapLocale(record: JsonRecord | null): JsonRecord | null {
  if (!record) return null;
  if ("title" in record || "content" in record) return record;
  for (const key of ["zh_cn", "en_us", "ja_jp", "zh_tw"]) {
    const value = asRecord(record[key]);
    if (value) return value;
  }
  return (
    Object.values(record)
      .map(asRecord)
      .find((value) => value && ("title" in value || "content" in value)) ?? null
  );
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readString(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNonNegativeInteger(record: JsonRecord | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function safeFilename(value: string | null): string | undefined {
  const name = value
    ? Array.from(value)
        .filter((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127;
        })
        .join("")
        .trim()
        .slice(0, 255)
    : undefined;
  return name || undefined;
}

function safeLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? value.replace(
          /[()\s]/g,
          (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
        )
      : null;
  } catch {
    return null;
  }
}

function escapeInline(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([`*_{}[\]()<>#+.!|~-])/g, "\\$1");
}

function escapeCardMarkdown(value: string): string {
  // Card Markdown is untrusted content, not HTML. Escape it as one inert
  // Markdown string instead of repeatedly stripping tag-shaped substrings:
  // chained removals can turn nested input such as <scr<script>ipt> into a
  // newly active <script> sequence.
  return escapeInline(value.trim());
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function adjacentUnique(values: string[]): string[] {
  return values.filter((value, index) => value !== values[index - 1]);
}

function fallbackFor(type: string, fallback?: string): string {
  return fallback?.trim() || `[不支持的飞书消息类型：${type || "unknown"}]`;
}
