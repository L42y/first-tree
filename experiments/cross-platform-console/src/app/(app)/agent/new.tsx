import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";

import type { CreateAgentInput } from "~/lib/team-api";
import { createAgent } from "~/lib/team-api";
import { colors } from "~/lib/theme";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function suggestName(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug;
}

/**
 * New agent — creation form over `POST /agents` (same body the web console
 * sends). Human mirrors are lifecycle-managed and not creatable here.
 */
export default function NewAgentScreen() {
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [visibility, setVisibility] = useState<"private" | "organization">("organization");
  const [saving, setSaving] = useState(false);

  const effectiveName = nameEdited ? name.trim() : suggestName(displayName);
  const canSubmit = displayName.trim().length > 0 && NAME_RE.test(effectiveName) && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const input: CreateAgentInput = {
        type: "agent",
        displayName: displayName.trim(),
        visibility,
      };
      if (effectiveName) input.name = effectiveName;
      const created = await createAgent(input);
      router.replace(`/agent/${created.uuid}`);
    } catch (err) {
      Alert.alert(
        "Couldn't create agent",
        err instanceof Error ? err.message : "Unexpected error. Try again.",
      );
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>New agent</Text>

      <Text style={styles.label}>Display name</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={(text) => {
          setDisplayName(text);
          if (!nameEdited) setName(suggestName(text));
        }}
        placeholder="e.g. Review Bot"
        placeholderTextColor={colors.textMuted}
        autoFocus
      />

      <Text style={styles.label}>Handle (optional)</Text>
      <View style={styles.handleWrap}>
        <Text style={styles.handlePrefix}>@</Text>
        <TextInput
          style={styles.handleInput}
          value={nameEdited ? name : effectiveName}
          onChangeText={(text) => {
            setNameEdited(true);
            setName(text.toLowerCase());
          }}
          placeholder="handle"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      {!NAME_RE.test(effectiveName) && (
        <Text style={styles.hint}>
          Lowercase letters, digits, hyphens, underscores. Starts with a letter or digit.
        </Text>
      )}

      <Text style={styles.label}>Visibility</Text>
      <View style={styles.segmentRow}>
        {(["organization", "private"] as const).map((option) => (
          <Pressable
            key={option}
            onPress={() => setVisibility(option)}
            style={[styles.segment, visibility === option && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, visibility === option && styles.segmentTextActive]}>
              {option === "organization" ? "Workspace" : "Private"}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        disabled={!canSubmit}
        onPress={() => void submit()}
        style={({ pressed }) => [styles.submitButton, !canSubmit && styles.disabled, pressed && styles.pressed]}
      >
        {saving ? (
          <ActivityIndicator size="small" color={colors.accentText} />
        ) : (
          <Text style={styles.submitText}>Create agent</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.text,
    marginBottom: 16,
  },
  label: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
    marginTop: 14,
    marginBottom: 6,
  },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  handleWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
    paddingHorizontal: 12,
  },
  handlePrefix: {
    color: colors.textMuted,
    fontSize: 15,
    marginRight: 2,
  },
  handleInput: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    paddingVertical: 12,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: -4,
  },
  segmentRow: {
    flexDirection: "row",
    gap: 8,
  },
  segment: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    paddingVertical: 10,
  },
  segmentActive: {
    borderColor: colors.accent,
    backgroundColor: "rgba(59,130,246,0.15)",
  },
  segmentText: {
    color: colors.textSecondary,
    fontWeight: "600",
  },
  segmentTextActive: {
    color: colors.accentText,
  },
  submitButton: {
    marginTop: 24,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: "center",
    paddingVertical: 13,
  },
  submitText: {
    color: colors.accentText,
    fontWeight: "700",
    fontSize: 15,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.75,
  },
});
