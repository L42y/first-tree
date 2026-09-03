import Ionicons from "@expo/vector-icons/Ionicons";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Avatar } from "~/components/avatar";
import { formatLastActive, type ParticipantRosterRow, participantRoleLabel } from "~/lib/participants";
import { colors } from "~/lib/theme";

/**
 * Who is in this chat, ordered by who spoke last. Opened from the chat header,
 * which shows the same order collapsed into a single subtitle line.
 */
export function ChatParticipantsSheet({
  visible,
  rows,
  onClose,
}: {
  visible: boolean;
  rows: readonly ParticipantRosterRow[];
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const now = Date.now();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.grabber} />
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Participants</Text>
          <Text style={styles.sheetCount}>{rows.length}</Text>
          <View style={styles.spacer} />
          <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close participants">
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </Pressable>
        </View>
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
                    {row.isSelf && <Text style={styles.youTag}>You</Text>}
                  </View>
                  <Text style={styles.meta} numberOfLines={1}>
                    {row.participant.name ? `@${row.participant.name} · ` : ""}
                    {participantRoleLabel(row)}
                  </Text>
                </View>
                <Text style={[styles.activity, row.lastActiveAt === null && styles.activityIdle]} numberOfLines={1}>
                  {formatLastActive(row.lastActiveAt, now)}
                </Text>
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
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
  meta: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  activity: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  activityIdle: {
    color: colors.textMuted,
  },
});
