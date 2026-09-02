import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CollapsingHeaderBar, LargeTitle, useCollapsingHeaderScroll } from "~/components/collapsing-header";
import type { ContextTreeWindow } from "~/lib/context-api";
import { getContextTreeSnapshot } from "~/lib/context-api";
import { useTabBarFloatingInset } from "~/lib/tab-bar-inset";
import { colors } from "~/lib/theme";

const WINDOWS: ContextTreeWindow[] = ["1d", "7d", "30d"];
const LIST_BOTTOM_PADDING = 24;

/**
 * Context — read-only feed of context-tree writes for the active
 * workspace (same `/context-tree/snapshot` source as the web console's
 * Context page). Tap an entry to expand its summary.
 */
export default function ContextScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;
  const tabBarInset = useTabBarFloatingInset();
  const insets = useSafeAreaInsets();
  const { scrollY, onScroll } = useCollapsingHeaderScroll();
  const [window, setWindow] = useState<ContextTreeWindow>("7d");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["context-tree", "snapshot", window],
    queryFn: ({ signal }) => getContextTreeSnapshot(window, signal),
    refetchInterval: 60_000,
  });

  const updates = data?.updates ?? [];

  return (
    <View style={styles.container}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.list,
          isWide && styles.wideList,
          { paddingTop: insets.top, paddingBottom: LIST_BOTTOM_PADDING + tabBarInset },
        ]}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.textMuted} />
        }
      >
        <LargeTitle>Context</LargeTitle>
        <View style={styles.windowRow}>
          {WINDOWS.map((w) => (
            <Pressable key={w} onPress={() => setWindow(w)} style={[styles.chip, window === w && styles.chipActive]}>
              <Text style={[styles.chipText, window === w && styles.chipTextActive]}>{w}</Text>
            </Pressable>
          ))}
        </View>

        {isLoading && !data ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.textMuted} />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>{error instanceof Error ? error.message : "Failed to load context"}</Text>
          </View>
        ) : updates.length === 0 ? (
          <View style={[styles.center, isWide && styles.wideCenter]}>
            <Text style={styles.emptyText}>No context changes in the last {window}.</Text>
          </View>
        ) : (
          updates.map((update) => {
            const expanded = expandedId === update.id;
            return (
              <Pressable
                key={update.id}
                onPress={() => setExpandedId(expanded ? null : update.id)}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.entryTitle} numberOfLines={1}>
                    {update.title}
                  </Text>
                  <Text style={styles.nodePath} numberOfLines={1}>
                    {update.path}
                  </Text>
                  {expanded && update.summary ? <Text style={styles.summary}>{update.summary}</Text> : null}
                  <Text style={styles.meta}>
                    {update.changeType}
                    {update.changedBy ? ` · ${update.changedBy}` : ""}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </Animated.ScrollView>
      <CollapsingHeaderBar title="Context" scrollY={scrollY} />
    </View>
  );
}

const styles = StyleSheet.create({
  wideCenter: {
    maxWidth: 900,
    width: "100%",
    alignSelf: "center",
  },
  wideList: {
    maxWidth: 900,
    width: "100%",
    alignSelf: "center",
    paddingHorizontal: 16,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  windowRow: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 9999,
    backgroundColor: colors.surface,
  },
  chipActive: {
    backgroundColor: colors.accent,
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  chipTextActive: {
    color: colors.accentText,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  errorText: {
    color: colors.danger,
    textAlign: "center",
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: "center",
  },
  list: {
    paddingBottom: LIST_BOTTOM_PADDING,
  },
  card: {
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
    padding: 12,
  },
  pressed: {
    opacity: 0.75,
  },
  rowMain: {
    gap: 3,
  },
  entryTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  nodePath: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: "Menlo",
  },
  summary: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 4,
  },
  meta: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 4,
    textTransform: "capitalize",
  },
});
