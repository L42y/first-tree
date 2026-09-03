import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { type ChatSummaryState, formatSummaryAge } from "~/lib/chat-summary";
import { colors } from "~/lib/theme";

/**
 * The chat's current state, above the timeline. Collapsed it is one line, so
 * it never costs the conversation much room; a summary written since the last
 * visit opens itself once, because that is the case where the reader most
 * needs it before scrolling.
 */
export function ChatSummaryCard({ summary, chatId }: { summary: ChatSummaryState | null; chatId: string }) {
  const [expanded, setExpanded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm per chat, not per summary edit.
  useEffect(() => {
    setExpanded(false);
  }, [chatId]);
  const [autoExpanded, setAutoExpanded] = useState(false);
  useEffect(() => {
    if (!summary?.isUnread || autoExpanded) return;
    setAutoExpanded(true);
    setExpanded(true);
  }, [summary?.isUnread, autoExpanded]);

  if (!summary) return null;
  const age = formatSummaryAge(summary.updatedAt);
  return (
    <Pressable
      onPress={() => setExpanded((previous) => !previous)}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      accessibilityLabel={expanded ? "Collapse chat summary" : "Expand chat summary"}
    >
      <View style={styles.head}>
        <Ionicons name="document-text-outline" size={13} color={colors.textMuted} />
        <Text style={styles.kicker}>Summary</Text>
        {summary.isUnread && <View style={styles.unreadDot} />}
        <View style={styles.spacer} />
        {age && <Text style={styles.age}>{age}</Text>}
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={14} color={colors.textMuted} />
      </View>
      <Text style={styles.body} numberOfLines={expanded ? undefined : 1}>
        {summary.text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 10,
    gap: 4,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardPressed: {
    backgroundColor: colors.surfaceStrong,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  kicker: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  spacer: {
    flex: 1,
  },
  age: {
    color: colors.textMuted,
    fontSize: 11,
  },
  body: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
});
