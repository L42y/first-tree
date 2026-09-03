import Ionicons from "@expo/vector-icons/Ionicons";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AddParticipantConfirm } from "~/components/add-participant-confirm";
import { AgentMetaLine } from "~/components/agent-meta";
import { Avatar } from "~/components/avatar";
import { canToggleAgentRun } from "~/lib/agent-runtime";
import { formatLastActive, type ParticipantRosterRow } from "~/lib/participants";
import { reactivateAgent, suspendAgent } from "~/lib/team-api";
import { colors } from "~/lib/theme";
import { useAddParticipant, useDirectoryCandidates } from "~/lib/use-add-participant";
import { useAgentRuntimeSummaries } from "~/lib/use-agent-runtime";

/**
 * Who is in this chat, ordered by who spoke last. Opened from the chat header,
 * which shows the same order collapsed into a single subtitle line.
 */
export function ChatParticipantsSheet({
  visible,
  rows,
  chatId,
  selfAgentId,
  onClose,
}: {
  visible: boolean;
  rows: readonly ParticipantRosterRow[];
  chatId: string;
  selfAgentId?: string | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const now = Date.now();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const addFlow = useAddParticipant(chatId);
  // Only searched while the sheet is actually in add mode.
  const { candidates, isFetching } = useDirectoryCandidates({
    query: search,
    enabled: visible && adding,
    selfAgentId,
  });
  const rosterIds = useMemo(() => new Set(rows.map((row) => row.participant.agentId)), [rows]);
  const shownAgentIds = useMemo(
    () => [...rosterIds, ...candidates.map((candidate) => candidate.agentId)],
    [candidates, rosterIds],
  );
  const runtimeSummaries = useAgentRuntimeSummaries(shownAgentIds, { enabled: visible });
  const queryClient = useQueryClient();
  const [togglingAgentId, setTogglingAgentId] = useState<string | null>(null);

  // Pause / resume is `suspend` / `reactivate`, the same pair the agent detail
  // screen drives. Pausing stops an agent mid-conversation, so it asks first;
  // resuming just puts it back to work and does not.
  const toggleAgentRun = async (agentId: string, paused: boolean) => {
    setTogglingAgentId(agentId);
    try {
      await (paused ? reactivateAgent(agentId) : suspendAgent(agentId));
      await queryClient.invalidateQueries({ queryKey: ["agents", "org-list"] });
      await queryClient.invalidateQueries({ queryKey: ["me", "managed-agents"] });
    } catch (err) {
      Alert.alert("Couldn't update the agent", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setTogglingAgentId(null);
    }
  };

  const requestToggle = (agentId: string, displayName: string, paused: boolean) => {
    if (paused) {
      void toggleAgentRun(agentId, true);
      return;
    }
    Alert.alert("Pause this agent?", `${displayName} stops picking up work until you resume it.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Pause", style: "destructive", onPress: () => void toggleAgentRun(agentId, false) },
    ]);
  };
  const addable = useMemo(
    () =>
      candidates
        .filter((candidate) => !rosterIds.has(candidate.agentId))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [candidates, rosterIds],
  );

  const closeSheet = () => {
    setAdding(false);
    setSearch("");
    addFlow.cancel();
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={closeSheet}>
      <Pressable style={styles.backdrop} onPress={closeSheet} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.grabber} />
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>{adding ? "Add participant" : "Participants"}</Text>
          {!adding && <Text style={styles.sheetCount}>{rows.length}</Text>}
          <View style={styles.spacer} />
          {adding ? (
            <Pressable
              onPress={() => {
                setAdding(false);
                setSearch("");
                addFlow.cancel();
              }}
              hitSlop={8}
              accessibilityLabel="Back to participants"
            >
              <Text style={styles.headerAction}>Done</Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => setAdding(true)} hitSlop={8} accessibilityLabel="Add participant">
              <Text style={styles.headerAction}>Add</Text>
            </Pressable>
          )}
          <Pressable onPress={closeSheet} hitSlop={8} accessibilityLabel="Close participants">
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </Pressable>
        </View>
        {addFlow.pending ? (
          <AddParticipantConfirm flow={addFlow} onConfirm={() => void addFlow.confirm()} />
        ) : adding ? (
          <>
            <TextInput
              style={styles.search}
              value={search}
              onChangeText={setSearch}
              placeholder="Search people and agents"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
              {addable.length === 0 ? (
                <Text style={styles.empty}>
                  {isFetching ? "Searching…" : search ? "Nobody matches that" : "Everyone available is already here"}
                </Text>
              ) : (
                addable.map((candidate) => (
                  <Pressable
                    key={candidate.agentId}
                    onPress={() => addFlow.request(candidate)}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    <Avatar
                      name={candidate.displayName}
                      seed={candidate.agentId}
                      colorToken={candidate.avatarColorToken}
                      imageUrl={candidate.avatarImageUrl}
                      kind={candidate.type === "human" ? "human" : "agent"}
                      size={40}
                    />
                    <View style={styles.rowMain}>
                      <View style={styles.nameLine}>
                        <Text style={styles.name} numberOfLines={1}>
                          {candidate.displayName}
                        </Text>
                        <Text style={styles.handle} numberOfLines={1}>
                          @{candidate.name}
                        </Text>
                      </View>
                      <AgentMetaLine summary={runtimeSummaries.get(candidate.agentId)} />
                    </View>
                    <Text style={styles.addAction}>Add</Text>
                  </Pressable>
                ))
              )}
              {isFetching && addable.length > 0 && (
                <ActivityIndicator style={styles.searchSpinner} size="small" color={colors.textMuted} />
              )}
            </ScrollView>
          </>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            {rows.length === 0 ? (
              <Text style={styles.empty}>No participants yet</Text>
            ) : (
              rows.map((row) => (
                <View key={row.participant.agentId} style={styles.row}>
                  <Avatar
                    name={row.participant.displayName}
                    seed={row.participant.agentId}
                    colorToken={row.participant.avatarColorToken}
                    imageUrl={row.participant.avatarImageUrl}
                    kind={row.participant.type === "human" ? "human" : "agent"}
                    size={40}
                  />
                  <View style={styles.rowMain}>
                    <View style={styles.nameLine}>
                      <Text style={styles.name} numberOfLines={1}>
                        {row.participant.displayName}
                      </Text>
                      {row.participant.name && (
                        <Text style={styles.handle} numberOfLines={1}>
                          @{row.participant.name}
                        </Text>
                      )}
                      {row.isSelf && <Text style={styles.youTag}>You</Text>}
                    </View>
                    <AgentMetaLine summary={runtimeSummaries.get(row.participant.agentId)} showActivity />
                  </View>
                  <View style={styles.rowTrailing}>
                    <Text style={[styles.activity, row.lastActiveAt === null && styles.activityIdle]} numberOfLines={1}>
                      {formatLastActive(row.lastActiveAt, now)}
                    </Text>
                    {(() => {
                      const summary = runtimeSummaries.get(row.participant.agentId);
                      if (!canToggleAgentRun(summary)) return null;
                      const paused = summary?.status === "suspended";
                      const busy = togglingAgentId === row.participant.agentId;
                      return (
                        <Pressable
                          onPress={() => requestToggle(row.participant.agentId, row.participant.displayName, paused)}
                          disabled={busy}
                          hitSlop={8}
                          accessibilityLabel={paused ? "Resume agent" : "Pause agent"}
                          style={({ pressed }) => [styles.runToggle, pressed && styles.rowPressed]}
                        >
                          {busy ? (
                            <ActivityIndicator size="small" color={colors.textMuted} />
                          ) : (
                            <Ionicons
                              name={paused ? "play-circle-outline" : "pause-circle-outline"}
                              size={22}
                              color={paused ? colors.accent : colors.textSecondary}
                            />
                          )}
                        </Pressable>
                      );
                    })()}
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        )}
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
    maxHeight: "70%",
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
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  sheetCount: {
    color: colors.textMuted,
    fontSize: 15,
  },
  headerAction: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
    paddingHorizontal: 4,
  },
  addAction: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  search: {
    marginHorizontal: 16,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 15,
  },
  searchSpinner: {
    paddingVertical: 12,
  },
  rowPressed: {
    backgroundColor: colors.surface,
  },
  spacer: {
    flex: 1,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 14,
    paddingVertical: 24,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  nameLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  name: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  youTag: {
    color: colors.textMuted,
    fontSize: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: "hidden",
  },
  handle: {
    color: colors.textMuted,
    fontSize: 12,
    flexShrink: 1,
  },
  rowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  runToggle: {
    padding: 2,
    borderRadius: 999,
  },
  activity: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  activityIdle: {
    color: colors.textMuted,
  },
});
