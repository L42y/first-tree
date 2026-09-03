import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { formatNextRun, scheduleStateLabel } from "~/lib/chat-schedule";
import { fetchChatRows, listMyCronJobs, type MyCronJob } from "~/lib/chats-api";
import { orderSchedules } from "~/lib/quick-views";
import { colors } from "~/lib/theme";

/**
 * Schedules — every cron job you own, in one request. This used to ask each
 * chat in turn because the server only listed jobs per chat; `/me/cron-jobs`
 * now answers the question the screen is actually asking.
 */
export default function SchedulesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const jobsQuery = useQuery({
    queryKey: ["me", "cron-jobs"],
    queryFn: ({ signal }) => listMyCronJobs(signal),
    refetchInterval: 60_000,
  });
  // Chat titles come from the conversation list the app already holds, so the
  // rows can say where a schedule runs without a second lookup per job.
  const rowsQuery = useQuery({
    queryKey: ["me", "chats", "list", "all"],
    queryFn: ({ signal }) => fetchChatRows("all", signal),
  });

  const jobs = useMemo(() => {
    const titles = new Map((rowsQuery.data ?? []).map((row) => [row.chatId, row.title]));
    return orderSchedules(jobsQuery.data ?? []).map((job) => ({
      job,
      chatId: (job as MyCronJob).controlChatId,
      chatTitle: titles.get((job as MyCronJob).controlChatId) ?? "",
    }));
  }, [jobsQuery.data, rowsQuery.data]);

  const loading = jobsQuery.isLoading;

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
        {!loading && jobs.length === 0 && <Text style={styles.empty}>Nothing is scheduled.</Text>}
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
                {entry.job.schedule}
                {entry.chatTitle ? ` · ${entry.chatTitle}` : ""}
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
