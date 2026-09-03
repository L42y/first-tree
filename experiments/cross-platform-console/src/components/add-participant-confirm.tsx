import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "~/lib/theme";
import type { AddParticipantFlow } from "~/lib/use-add-participant";

/**
 * The one confirmation for joining somebody to a chat, shared by the mention
 * picker and the participants sheet so both surfaces say the same thing about
 * what adding a member actually does.
 */
export function AddParticipantConfirm({
  flow,
  confirmLabel = "Add",
  onConfirm,
}: {
  flow: AddParticipantFlow;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  if (!flow.pending) return null;
  return (
    <View style={styles.confirm}>
      <Text style={styles.title}>Add {flow.pending.displayName} to this chat?</Text>
      <Text style={styles.body}>They aren't in this conversation yet. Adding them lets them read it and reply.</Text>
      {flow.error && <Text style={styles.error}>{flow.error}</Text>}
      <View style={styles.actions}>
        <Pressable
          onPress={flow.cancel}
          disabled={flow.adding}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={flow.adding}
          style={({ pressed }) => [styles.button, styles.primary, pressed && styles.primaryPressed]}
        >
          {flow.adding ? (
            <ActivityIndicator size="small" color={colors.accentText} />
          ) : (
            <Text style={styles.addText}>{confirmLabel}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  confirm: {
    padding: 12,
    gap: 6,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  body: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  error: {
    color: colors.danger,
    fontSize: 12,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    paddingTop: 4,
  },
  button: {
    minWidth: 88,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  buttonPressed: {
    backgroundColor: colors.surface,
  },
  primary: {
    backgroundColor: colors.accent,
  },
  primaryPressed: {
    opacity: 0.8,
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  addText: {
    color: colors.accentText,
    fontSize: 14,
    fontWeight: "600",
  },
});
