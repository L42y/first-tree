import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { fetchChatRows } from "~/lib/chats-api";
import { forgeChats } from "~/lib/quick-views";
import { colors } from "~/lib/theme";

const ENTITY_ICON: Record<string, string> = {
  pull_request: "git-pull-request-outline",
  issue: "alert-circle-outline",
  discussion: "chatbubbles-outline",
  commit: "git-commit-outline",
};

/**
 * Code — the pull requests and issues followed into your chats. Every followed
 * entity already is a chat carrying its origin, so this view is a reading of
 * the conversation list rather than a second source of truth that could
 * disagree with it.
 */
export default function ForgeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, isLoading } = useQuery({
    queryKey: ["me", "chats", "list", "all"],
    queryFn: ({ signal }) => fetchChatRows("all", signal),
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => forgeChats(data ?? []), [data]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 6 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Code</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        {isLoading && <ActivityIndicator color={colors.textMuted} />}
        {!isLoading && rows.length === 0 && (
          <Text style={styles.empty}>No pull requests or issues are followed into your chats.</Text>
        )}
        {rows.map((row) => (
          <Pressable
            key={row.chatId}
            onPress={() => router.push({ pathname: `/chat/${row.chatId}` } as never)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.rowHead}>
              <Ionicons
                name={(ENTITY_ICON[row.entityType ?? ""] ?? "logo-github") as never}
                size={15}
                color={colors.textSecondary}
              />
              <Text style={styles.rowTitle} numberOfLines={1}>
                {row.title}
              </Text>
              {row.unreadMentionCount > 0 && <View style={styles.dot} />}
            </View>
            {row.lastMessagePreview ? (
              <Text style={styles.rowMeta} numberOfLines={1}>
                {row.lastMessagePreview}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceStrong,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  body: { padding: 16, gap: 10 },
  empty: { color: colors.textMuted, fontSize: 14 },
  row: {
    gap: 4,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowPressed: { backgroundColor: colors.surfaceStrong },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "700" },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  rowMeta: { color: colors.textMuted, fontSize: 12 },
});
