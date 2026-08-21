import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import type { MeChatRow } from "@first-tree/shared";

type ChatListItemProps = {
  chat: MeChatRow;
};

export function ChatListItem({ chat }: ChatListItemProps) {
  const router = useRouter();
  const preview = chat.description ?? chat.lastMessagePreview ?? "No messages yet";
  const hasUnread = chat.unreadMentionCount > 0;

  return (
    <Pressable
      onPress={() => router.push(`/chat/${chat.chatId}`)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.content}>
        <View style={styles.header}>
          <Text
            style={[styles.title, hasUnread && styles.titleUnread]}
            numberOfLines={1}
          >
            {chat.title}
          </Text>
          {hasUnread && (
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(128,128,128,0.2)",
  },
  pressed: {
    opacity: 0.6,
  },
  content: {
    gap: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 16,
    flex: 1,
  },
  titleUnread: {
    fontWeight: "bold",
  },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#EF4444",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
    paddingHorizontal: 6,
  },
  badgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "bold",
  },
  preview: {
    opacity: 0.7,
  },
  participants: {
    fontSize: 12,
    opacity: 0.5,
  },
});
