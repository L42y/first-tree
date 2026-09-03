import Ionicons from "@expo/vector-icons/Ionicons";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { formatNextRun, scheduleStateLabel } from "~/lib/chat-schedule";
import { type ChatCronJob, fetchChatRows, listChatCronJobs } from "~/lib/chats-api";
import { orderSchedules } from "~/lib/quick-views";
import { colors } from "~/lib/theme";

/**
 * Schedules — every cron job run from a chat you are in.
 *
 * The server only lists jobs per chat, so this asks each chat and stitches the
 * answers together. That is the honest cost of the feature today; a
 * `/me/cron-jobs` endpoint would make it one request, and this cap exists so
 * the fan-out stays bounded until then.
 */
const MAX_CHATS_SCANNED = 40;

export default function SchedulesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const rowsQuery = useQuery({
    queryKey: ["me", "chats", "list", "all"],
    queryFn: ({ signal }) => fetchChatRows("all", signal),
  });
  const chatIds = useMemo(() => (rowsQuery.data ?? []).slice(0, MAX_CHATS_SCANNED), [rowsQuery.data]);

  const jobQueries = useQueries({
    queries: chatIds.map((row) => ({
      queryKey: ["chats", row.chatId, "cron-jobs"],
      queryFn: ({ signal }: { signal: AbortSignal }) => listChatCronJobs(row.chatId, signal),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });

  const jobs = useMemo(() => {
    const titles = new Map(chatIds.map((row) => [row.chatId, row.title]));
    const collected: Array<{ job: ChatCronJob; chatId: string; chatTitle: string }> = [];
    jobQueries.forEach((query, index) => {
      const chat = chatIds[index];
      if (!chat) return;
      for (const job of query.data ?? []) {
        collected.push({ job, chatId: chat.chatId, chatTitle: titles.get(chat.chatId) ?? chat.title });
      }
    });
    const ordered = orderSchedules(collected.map((entry) => entry.job));
    return ordered.map((job) => collected.find((entry) => entry.job.id === job.id)).filter((entry) => entry != null);
  }, [chatIds, jobQueries]);

  const loading = rowsQuery.isLoading || jobQueries.some((query) => query.isLoading);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 6 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Schedules</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        {loading && <ActivityIndicator color={colors.textMuted} />}
        {!loading && jobs.length === 0 && <Text style={styles.empty}>No schedules run from your chats.</Text>}
        {jobs.map((entry) => {
          const paused = scheduleStateLabel(entry.job.state);
          return (
            <Pressable
              key={entry.job.id}
              onPress={() => router.push({ pathname: `/chat/${entry.chatId}` } as never)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowHead}>
                <Ionicons
                  name={paused ? "pause-circle-outline" : "time-outline"}
                  size={15}
                  color={paused ? "#C99F00" : colors.textSecondary}
                />
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {entry.job.name}
                </Text>
                <Text style={[styles.rowWhen, paused && styles.rowPaused]} numberOfLines={1}>
                  {paused ?? formatNextRun(entry.job.nextRunAt)}
                </Text>
              </View>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {entry.job.schedule} · {entry.chatTitle}
              </Text>
            </Pressable>
          );
        })}
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
  rowWhen: { color: colors.textSecondary, fontSize: 12 },
  rowPaused: { color: "#C99F00", fontWeight: "600" },
  rowMeta: { color: colors.textMuted, fontSize: 12 },
});
