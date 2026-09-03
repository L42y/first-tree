import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CatchUpCardView } from "~/components/catch-up-deck";
import { buildCatchUpQueue, remainingLabel, resolveDeckIndex } from "~/lib/catch-up";
import { fetchChatRows } from "~/lib/chats-api";
import { colors } from "~/lib/theme";

/**
 * Needs you — everything waiting on you, as a deck rather than a list.
 *
 * The list this replaced showed the same information and asked nothing: you
 * read it, opened something, and lost your place. A deck is finite and asks
 * one question per card, which is the whole idea behind Slack's Catch Up: the
 * counter goes down, the last card ends, and "done" is a state you can
 * actually reach.
 */
export default function AttentionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [keptKeys, setKeptKeys] = useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["me", "chats", "list", "all"],
    queryFn: ({ signal }) => fetchChatRows("all", signal),
    refetchInterval: 30_000,
  });

  const queue = useMemo(() => buildCatchUpQueue(data ?? []), [data]);
  // Kept cards stay in the deck's tail rather than vanishing: "later" is a
  // decision to come back, not a decision to hide.
  const cards = useMemo(() => {
    const kept = new Set(keptKeys);
    return [...queue.filter((card) => !kept.has(card.key)), ...queue.filter((card) => kept.has(card.key))];
  }, [keptKeys, queue]);

  const position = resolveDeckIndex(cards, activeKey, index);
  const card = cards[position] ?? null;
  const done = !isLoading && (cards.length === 0 || position >= cards.length);

  const advance = (outcome: "cleared" | "kept") => {
    if (!card) return;
    if (outcome === "kept") setKeptKeys((previous) => [...new Set([...previous, card.key])]);
    const next = cards[position + 1] ?? null;
    setActiveKey(next?.key ?? null);
    setIndex(position + (outcome === "kept" ? 0 : 1));
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 6, paddingBottom: insets.bottom + 12 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{done ? "Needs you" : remainingLabel(cards, position)}</Text>
        <View style={styles.back} />
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : done ? (
        <View style={styles.center}>
          <Ionicons name="checkmark-done-circle-outline" size={44} color={colors.textMuted} />
          <Text style={styles.doneTitle}>You're all caught up</Text>
          <Text style={styles.doneHint}>Nothing is waiting on you right now.</Text>
        </View>
      ) : card ? (
        <View style={styles.deck}>
          {/* The next card peeking out is the deck's promise that this ends. */}
          {cards[position + 1] && <View style={[styles.ghostCard, styles.ghostSecond]} />}
          {cards[position + 2] && <View style={[styles.ghostCard, styles.ghostThird]} />}
          <CatchUpCardView key={card.key} card={card} onDone={advance} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  back: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceStrong,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  deck: {
    flex: 1,
    paddingBottom: 10,
  },
  // Slack stacks the remaining cards behind the current one; the edges are the
  // progress bar you do not have to read.
  ghostCard: {
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    height: 24,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  ghostSecond: {
    bottom: -6,
    marginHorizontal: 8,
  },
  ghostThird: {
    bottom: -11,
    marginHorizontal: 16,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  doneTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  doneHint: {
    color: colors.textMuted,
    fontSize: 14,
  },
});
