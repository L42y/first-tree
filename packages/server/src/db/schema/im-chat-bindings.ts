import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { chats } from "./chats.js";
import { imBotBindings } from "./im-bot-bindings.js";

/** Stable mapping from one Bot + Feishu chat_id to one canonical First Tree chat. */
export const imChatBindings = pgTable(
  "im_chat_bindings",
  {
    id: text("id").primaryKey(),
    botBindingId: text("bot_binding_id")
      .notNull()
      .references(() => imBotBindings.id, { onDelete: "cascade" }),
    feishuChatId: text("feishu_chat_id").notNull(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    feishuChatType: text("feishu_chat_type").notNull(),
    titleSnapshot: text("title_snapshot"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_im_chat_bindings_bot_chat").on(table.botBindingId, table.feishuChatId),
    uniqueIndex("uq_im_chat_bindings_chat").on(table.chatId),
    check("chk_im_chat_bindings_chat_type", sql`${table.feishuChatType} IN ('p2p', 'group')`),
    check("chk_im_chat_bindings_status", sql`${table.status} IN ('active', 'detached')`),
  ],
);
