import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import type { ContextTreeWindow } from "~/lib/context-api";
import { getContextTreeSnapshot } from "~/lib/context-api";
import { colors } from "~/lib/theme";

const WINDOWS: ContextTreeWindow[] = ["1d", "7d", "30d"];

/**
 * Context — read-only feed of context-tree writes for the active
 * workspace (same `/context-tree/snapshot` source as the web console's
 * Context page). Tap an entry to expand its summary.
 */
export default function ContextScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;
  const [window, setWindow] = useState<ContextTreeWindow>("7d");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["context-tree", "snapshot", window],
    queryFn: ({ signal }) => getContextTreeSnapshot(window, signal),
    refetchInterval: 60_000,
  });

  const updates = data?.updates ?? [];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Context</Text>
        <View style={styles.windowRow}>
          {WINDOWS.map((w) => (
            <Pressable
              key={w}
              onPress={() => setWindow(w)}
              style={[styles.chip, window === w && styles.chipActive]}
            >
              <Text style={[styles.chipText, window === w && styles.chipTextActive]}>{w}</Text>
            </Pressable>
          ))}
        </View>
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
        <ScrollView contentContainerStyle={isWide ? [styles.list, styles.wideList] : styles.list}>
          {updates.map((update) => {
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
                  {expanded && update.summary ? (
                    <Text style={styles.summary}>{update.summary}</Text>
                  ) : null}
                  <Text style={styles.meta}>
                    {update.changeType}
                    {update.changedBy ? ` · ${update.changedBy}` : ""}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
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
  header: {
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.text,
  },
  windowRow: {
    flexDirection: "row",
    gap: 6,
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
    paddingBottom: 24,
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
