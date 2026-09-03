import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { colors } from "~/lib/theme";

/**
 * Rename a chat. `Alert.prompt` is iOS-only, so the title edit is a real
 * modal — the chat header is the natural place to rename from, and it has to
 * work on every platform the console runs on.
 */
export function RenameChatModal({
  visible,
  initialTitle,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  initialTitle: string;
  onCancel: () => void;
  onSubmit: (topic: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initialTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setValue(initialTitle);
    setError(null);
  }, [visible, initialTitle]);

  const trimmed = value.trim();
  const save = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename this chat");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.center} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.title}>Rename chat</Text>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder="Chat title"
            placeholderTextColor={colors.textMuted}
            maxLength={500}
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            autoFocus
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <View style={styles.actions}>
            <Pressable onPress={onCancel} disabled={saving} style={styles.button}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void save()}
              disabled={saving || !trimmed}
              style={({ pressed }) => [styles.button, styles.primary, (pressed || !trimmed) && styles.primaryMuted]}
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.accentText} />
              ) : (
                <Text style={styles.saveText}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
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
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    gap: 10,
    padding: 16,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceFloating,
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 15,
  },
  error: {
    color: colors.danger,
    fontSize: 12,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  button: {
    minWidth: 88,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
  },
  primary: {
    backgroundColor: colors.accent,
  },
  primaryMuted: {
    opacity: 0.6,
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  saveText: {
    color: colors.accentText,
    fontSize: 14,
    fontWeight: "600",
  },
});
