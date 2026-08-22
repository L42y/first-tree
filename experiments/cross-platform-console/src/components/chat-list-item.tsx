import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import type { MeChatRow } from "@first-tree/shared";
import { Avatar } from "~/components/avatar";
import { colors } from "~/lib/theme";

type ChatListItemProps = {
  chat: MeChatRow;
  /** Caller's own agent id — used to pick the peer for the avatar. */
  selfAgentId: string | null;
  /** Wide-screen selection mode: handle tap instead of router.push. */
  onPressChat?: (chatId: string) => void;
  /** Long-press handler (archive/unarchive menu). */
  onLongPressChat?: (chat: MeChatRow) => void;
};

export function ChatListItem({ chat, selfAgentId, onPressChat, onLongPressChat }: ChatListItemProps) {
  const pinned = chat.pinnedAt !== null && chat.pinnedAt !== undefined;
  const hasOpenAsk = chat.openRequestCount > 0;
  const router = useRouter();
  const preview = chat.description ?? chat.lastMessagePreview ?? "No messages yet";
  const hasUnread = chat.unreadMentionCount > 0;

  // Direct chats show the peer; group chats lead with the first non-self
  // speaker. With no participants at all, fall back to a title-seeded disc.
  const peer =
    chat.participants.find((p) => p.agentId !== selfAgentId) ?? chat.participants[0] ?? null;
  const avatarName = peer?.displayName ?? chat.title;
  const avatarSeed = peer?.agentId ?? chat.chatId;

  return (
    <Pressable
      onPress={() =>
        onPressChat ? onPressChat(chat.chatId) : router.push(`/chat/${chat.chatId}`)
      }
      onLongPress={() => onLongPressChat?.(chat)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar
        name={avatarName}
        seed={avatarSeed}
        colorToken={peer?.avatarColorToken ?? null}
        imageUrl={peer?.avatarImageUrl ?? null}
        kind={peer ? (peer.type === "human" ? "human" : "agent") : "agent"}
        size={44}
      />
      <View style={styles.content}>
        <View style={styles.header}>
          {pinned && (
            <View style={styles.pinBadge}>
              <Text style={styles.pinGlyph}>📌</Text>
            </View>
          )}
          <Text
            style={[styles.title, hasUnread && styles.titleUnread]}
            numberOfLines={1}
          >
            {chat.title}
          </Text>
          {hasOpenAsk && (
            <View style={[styles.badge, styles.askBadge]}>
              <Text style={styles.badgeText}>?</Text>
            </View>
          )}
          {!hasOpenAsk && hasUnread && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{chat.unreadMentionCount}</Text>
            </View>
          )}
        </View>
        <Text style={styles.preview} numberOfLines={2}>
          {preview}
        </Text>
        {chat.participants.length > 0 && (
          <Text style={styles.participants} numberOfLines={1}>
            {chat.participants.map((p) => p.displayName).join(", ")}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: {
    opacity: 0.6,
  },
  content: {
    flex: 1,
    gap: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  pinBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  pinGlyph: {
    fontSize: 10,
  },
  title: {
    fontSize: 16,
    flex: 1,
    color: colors.text,
  },
  titleUnread: {
    fontWeight: "bold",
  },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
    paddingHorizontal: 6,
  },
  askBadge: {
    paddingHorizontal: 7,
  },
  badgeText: {
    color: colors.accentText,
    fontSize: 12,
    fontWeight: "bold",
  },
  preview: {
    color: colors.textSecondary,
  },
  participants: {
    fontSize: 12,
    color: colors.textMuted,
  },
});
