import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { Message } from "@first-tree/shared";
import { MarkdownText } from "~/components/markdown-text";
import type { ParsedRequest } from "~/lib/ask";
import { colors } from "~/lib/theme";

/**
 * Docked answer surface for the viewer's own open ask — bottom-docked,
 * directly above the composer, modeled on the web console's AskTakeover:
 *
 *   - question body (markdown, scrollable so long asks never push the
 *     controls away) + option cards (radio/checkbox semantics)
 *   - ONE shared free-text input inside the dock (the composer's role
 *     while the dock is expanded)
 *   - pinned footer: Ask agent · Skip · Submit — Submit and Skip resolve
 *     the question; Ask agent posts a clarification @mention without
 *     resolving it
 *   - "Show earlier chat" collapses the dock into a slim pending bar so
 *     the conversation is readable; tap to re-expand
 */
export function RequestDock({
  question,
  parsed,
  collapsed,
  onToggleCollapsed,
  onSubmit,
  onSkip,
  onAskAgent,
}: {
  question: Message;
  parsed: ParsedRequest;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSubmit: (answer: string) => void;
  onSkip: () => void;
  onAskAgent: (text: string) => void;
}) {
  const options = parsed.request.options ?? [];
  const multiSelect = parsed.request.multiSelect === true;
  const [selected, setSelected] = useState<number[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  if (collapsed) {
    return (
      <Pressable onPress={onToggleCollapsed} style={({ pressed }) => [styles.collapsedBar, pressed && styles.pressed]}>
        <Text style={styles.collapsedKicker}>Open question</Text>
        <Text style={styles.collapsedText} numberOfLines={1}>
          Tap to answer
        </Text>
      </Pressable>
    );
  }

  const act = (fn: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      fn();
    } finally {
      setBusy(false);
    }
  };

  const composedAnswer = () => {
    const labels = selected.map((i) => options[i]?.label).filter(Boolean).join(", ");
    const note = text.trim();
    return [labels, note].filter(Boolean).join(" — ");
  };

  const canSubmit = selected.length > 0 || text.trim().length > 0;

  return (
    <View style={styles.dock}>
      <ScrollView style={styles.scroll} nestedScrollEnabled bounces={false}>
        <View style={styles.kickerRow}>
          <Text style={styles.kicker}>Asked you</Text>
          <Pressable onPress={onToggleCollapsed} hitSlop={8}>
            <Text style={styles.showEarlier}>Show earlier chat</Text>
          </Pressable>
        </View>
        <MarkdownText value={typeof question.content === "string" ? question.content : ""} />

        {options.length > 0 && (
          <View style={styles.options}>
            {options.map((option, index) => {
              const isSelected = selected.includes(index);
              return (
                <Pressable
                  key={`${index}-${option.label}`}
                  disabled={busy}
                  onPress={() =>
                    setSelected((prev) =>
                      multiSelect
                        ? prev.includes(index)
                          ? prev.filter((i) => i !== index)
                          : [...prev, index]
                        : [index],
                    )
                  }
                  style={[styles.option, isSelected && styles.optionSelected]}
                >
                  <Text style={styles.optionLabel}>
                    {multiSelect ? `${isSelected ? "☑" : "☐"} ` : ""}
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text style={styles.optionDescription}>{option.description}</Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={options.length > 0 ? "Other — add a note…" : "Your answer…"}
        placeholderTextColor={colors.textMuted}
        multiline
      />

      <View style={styles.footer}>
        <Pressable
          disabled={busy || !text.trim()}
          onPress={() => {
            const t = text.trim();
            setText("");
            onAskAgent(t);
          }}
          style={({ pressed }) => [
            styles.footerButton,
            (busy || !text.trim()) && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.footerButtonText}>Ask agent</Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() => act(onSkip)}
          style={({ pressed }) => [styles.footerButton, styles.secondaryButton, busy && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryButtonText}>Skip</Text>
        </Pressable>
        <Pressable
          disabled={busy || !canSubmit}
          onPress={() => {
            const answer = composedAnswer();
            setText("");
            setSelected([]);
            act(() => onSubmit(answer));
          }}
          style={({ pressed }) => [
            styles.footerButton,
            styles.primaryButton,
            styles.flex1,
            (busy || !canSubmit) && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.accentText} />
          ) : (
            <Text style={styles.primaryButtonText}>Submit</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    maxHeight: 300,
    backgroundColor: colors.surfaceStrong,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 8,
  },
  scroll: {
    flexGrow: 0,
  },
  kickerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  kicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
  },
  showEarlier: {
    fontSize: 12,
    color: colors.accent,
    fontWeight: "600",
  },
  options: {
    marginTop: 8,
    gap: 6,
  },
  option: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: "rgba(59,130,246,0.18)",
  },
  optionLabel: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 14,
  },
  optionDescription: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  input: {
    minHeight: 40,
    maxHeight: 96,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  footer: {
    flexDirection: "row",
    gap: 8,
    paddingBottom: 2,
  },
  footerButton: {
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  flex1: {
    flex: 1,
  },
  primaryButton: {
    backgroundColor: colors.accent,
  },
  primaryButtonText: {
    color: colors.accentText,
    fontWeight: "700",
  },
  secondaryButton: {
    backgroundColor: colors.surface,
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontWeight: "600",
  },
  footerButtonText: {
    color: colors.textSecondary,
    fontWeight: "600",
  },
  collapsedBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceStrong,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  collapsedKicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.accent,
  },
  collapsedText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  pressed: {
    opacity: 0.75,
  },
  disabled: {
    opacity: 0.45,
  },
});
