import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type Draft, draftPreview, loadDrafts } from "~/lib/drafts";
import { colors } from "~/lib/theme";

/**
 * Drafts — messages started and not sent, on this device only. They are the
 * one quick view with no server behind it: an unsent message is private until
 * its author decides otherwise.
 */
export default function DraftsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, isLoading } = useQuery({
    queryKey: ["drafts"],
    queryFn: () => loadDrafts(),
    refetchOnMount: "always",
  });
  const drafts = data ?? [];

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 6 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Drafts</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        {isLoading && <ActivityIndicator color={colors.textMuted} />}
        {!isLoading && drafts.length === 0 && (
          <Text style={styles.empty}>Nothing unsent. Drafts stay on this device.</Text>
        )}
        {drafts.map((draft: Draft) => (
          <Pressable
            key={draft.chatId}
            onPress={() => router.push({ pathname: `/chat/${draft.chatId}` } as never)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <Text style={styles.rowTitle} numberOfLines={1}>
              {draft.title || "Untitled chat"}
            </Text>
            <Text style={styles.rowPreview} numberOfLines={2}>
              {draftPreview(draft, 140)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
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
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  body: {
    padding: 16,
    gap: 10,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 14,
  },
  row: {
    gap: 4,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowPressed: {
    backgroundColor: colors.surfaceStrong,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  rowPreview: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
});
