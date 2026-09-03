import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { QuickView } from "~/lib/quick-views";
import { colors } from "~/lib/theme";

/**
 * The standing piles of work, above the conversation list. Slack's row of
 * quick views earns its space by being constant: the same tiles in the same
 * order every time, each with a live count, so the piles can be checked at a
 * glance instead of reconstructed by scrolling. A tile with nothing in it
 * still shows — "0 items" is information, and a row that reshuffles itself is
 * a row you have to read.
 */
export function QuickViews({ views }: { views: readonly QuickView[] }) {
  const router = useRouter();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.strip}
    >
      {views.map((view) => (
        <Pressable
          key={view.key}
          onPress={() => router.push(view.route as never)}
          accessibilityRole="button"
          accessibilityLabel={`${view.label}, ${view.subtitle}`}
          style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
        >
          <View style={styles.tileHead}>
            <Ionicons name={view.icon as never} size={17} color={colors.textSecondary} />
            {view.count > 0 && <View style={styles.dot} />}
          </View>
          <Text style={styles.tileLabel} numberOfLines={1}>
            {view.label}
          </Text>
          <Text style={styles.tileSubtitle} numberOfLines={1}>
            {view.subtitle}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexGrow: 0,
  },
  row: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  tile: {
    width: 128,
    gap: 2,
    padding: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tilePressed: {
    backgroundColor: colors.surfaceStrong,
  },
  tileHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 6,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  tileLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  tileSubtitle: {
    color: colors.textMuted,
    fontSize: 12,
  },
});
