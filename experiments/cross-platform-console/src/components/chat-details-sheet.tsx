import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery } from "@tanstack/react-query";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { formatEntitySubtitle, formatNextRun, scheduleStateLabel } from "~/lib/chat-schedule";
import { type ChatSummaryState, formatSummaryAge } from "~/lib/chat-summary";
import { listChatCronJobs, listChatGithubEntities, listChatGitlabEntities } from "~/lib/chats-api";
import { colors } from "~/lib/theme";

/**
 * Everything about the chat that is not the conversation: its current-state
 * Summary, the schedules it controls, and the PRs / issues wired into it.
 * Lives behind the header rather than above the timeline — this is reference
 * material a reader goes looking for, not something worth a permanent strip.
 */
export function ChatDetailsSheet({
  visible,
  chatId,
  title,
  summary,
  onRename,
  onClose,
}: {
  visible: boolean;
  chatId: string;
  title: string;
  summary: ChatSummaryState | null;
  onRename: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  const githubQuery = useQuery({
    queryKey: ["chats", chatId, "github-entities"],
    queryFn: ({ signal }) => listChatGithubEntities(chatId, signal),
    enabled: visible,
    staleTime: 30_000,
  });
  const gitlabQuery = useQuery({
    queryKey: ["chats", chatId, "gitlab-entities"],
    queryFn: ({ signal }) => listChatGitlabEntities(chatId, signal),
    enabled: visible,
    staleTime: 30_000,
  });
  const cronQuery = useQuery({
    queryKey: ["chats", chatId, "cron-jobs"],
    queryFn: ({ signal }) => listChatCronJobs(chatId, signal),
    enabled: visible,
    staleTime: 30_000,
  });

  const entities = [...(githubQuery.data ?? []), ...(gitlabQuery.data ?? [])];
  const schedules = cronQuery.data ?? [];
  const summaryAge = formatSummaryAge(summary?.updatedAt ?? null);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.grabber} />
        <View style={styles.header}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          <Pressable onPress={onRename} hitSlop={8} accessibilityLabel="Rename chat">
            <Text style={styles.headerAction}>Rename</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.sectionTitle}>Current state</Text>
          {summary ? (
            <View style={styles.card}>
              <Text style={styles.summaryText}>{summary.text}</Text>
              {summaryAge && <Text style={styles.caption}>{summaryAge}</Text>}
            </View>
          ) : (
            <Text style={styles.empty}>No summary yet — the agent writes one as the work moves.</Text>
          )}

          <Text style={styles.sectionTitle}>Schedules</Text>
          {schedules.length === 0 ? (
            <Text style={styles.empty}>{cronQuery.isLoading ? "Loading…" : "No schedules run from this chat."}</Text>
          ) : (
            schedules.map((job) => {
              const paused = scheduleStateLabel(job.state);
              return (
                <View key={job.id} style={styles.card}>
                  <View style={styles.rowLine}>
                    <Ionicons name="time-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {job.name}
                    </Text>
                    {paused && <Text style={styles.pausedTag}>{paused}</Text>}
                  </View>
                  <Text style={styles.caption} numberOfLines={1}>
                    {job.schedule} · {paused ? "Paused" : formatNextRun(job.nextRunAt)}
                  </Text>
                </View>
              );
            })
          )}

          <Text style={styles.sectionTitle}>Linked work</Text>
          {entities.length === 0 ? (
            <Text style={styles.empty}>
              {githubQuery.isLoading || gitlabQuery.isLoading ? "Loading…" : "No pull requests or issues follow here."}
            </Text>
          ) : (
            entities.map((entity) => (
              <Pressable
                key={`${entity.entityType}-${entity.entityKey}`}
                onPress={() => void Linking.openURL(entity.htmlUrl)}
                style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              >
                <View style={styles.rowLine}>
                  <Ionicons name="git-pull-request-outline" size={14} color={colors.textMuted} />
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {entity.title ?? entity.entityKey}
                  </Text>
                  <Ionicons name="open-outline" size={13} color={colors.textMuted} />
                </View>
                <Text style={styles.caption} numberOfLines={1}>
                  {formatEntitySubtitle(entity)}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    marginTop: "auto",
    maxHeight: "80%",
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  grabber: {
    alignSelf: "center",
    marginTop: 8,
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  headerAction: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  body: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingTop: 10,
  },
  card: {
    gap: 4,
    padding: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardPressed: {
    backgroundColor: colors.surfaceStrong,
  },
  rowLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rowTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  pausedTag: {
    color: "#C99F00",
    fontSize: 11,
    fontWeight: "600",
  },
  summaryText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  caption: {
    color: colors.textMuted,
    fontSize: 12,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
  },
});
