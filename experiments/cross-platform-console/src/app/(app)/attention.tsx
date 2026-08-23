import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";

import type { MeChatRow } from "@first-tree/shared";
import { fetchChatRows } from "~/lib/chats-api";
import { colors } from "~/lib/theme";

/**
 * Attention — one aggregated surface for everything needing the user:
 * open asks first, then chats with unread mentions. Client-side view over
 * the same chat rows the list uses.
 */
export default function AttentionScreen() {
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["me", "chats", "list", "all"],
    queryFn: ({ signal }) => fetchChatRows("all", signal),
    refetchInterval: 30_000,
  });

  const rows = data ?? [];
  const openAsks = rows.filter((r) => r.openRequestCount > 0);
  const unread = rows.filter((r) => r.openRequestCount === 0 && r.unreadMentionCount > 0);

  const openChat = (chatId: string) =>
    router.push({ pathname: `/chat/${chatId}` } as never);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Needs you</Text>

      {isLoading && <Text style={styles.hint}>Loading…</Text>}

      {!isLoading && rows.length === 0 && (
        <Text style={styles.hint}>Nothing needs you right now.</Text>
      )}

      {openAsks.length > 0 && (
        <>
          <Text style={styles.section}>Open questions</Text>
          {openAsks.map((row) => (
            <AttentionRow key={`ask-${row.chatId}`} row={row} badge="?" onPress={() => openChat(row.chatId)} />
          ))}
        </>
      )}

      {unread.length > 0 && (
        <>
          <Text style={styles.section}>Unread mentions</Text>
          {unread.map((row) => (
            <AttentionRow
              key={`un-${row.chatId}`}
              row={row}
              badge={String(row.unreadMentionCount)}
              onPress={() => openChat(row.chatId)}
            />
          ))}
        </>
      )}
    </ScrollView>
  );
}

function AttentionRow({
  row,
  badge,
  onPress,
}: {
  row: MeChatRow;
  badge: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.badge}>
        <Text style={styles.badgeText}>{badge}</Text>
      </View>
      <View style={styles.main}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {row.title}
        </Text>
        {!!row.lastMessagePreview && (
          <Text style={styles.preview} numberOfLines={1}>
            {row.lastMessagePreview}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingTop: 48,
    paddingBottom: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.text,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  section: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  hint: {
    color: colors.textMuted,
    paddingHorizontal: 16,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
    padding: 12,
  },
  pressed: {
    opacity: 0.75,
  },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  badgeText: {
    color: colors.accentText,
    fontSize: 12,
    fontWeight: "700",
  },
  main: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  preview: {
    color: colors.textSecondary,
    fontSize: 13,
  },
});
