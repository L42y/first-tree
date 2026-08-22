import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { Message } from "@first-tree/shared";
import { MarkdownText } from "~/components/markdown-text";
import type { ParsedRequest } from "~/lib/ask";
import { colors } from "~/lib/theme";

/**
 * Docked answer surface for the viewer's own open ask, modeled on the web
 * console's AskTakeover (packages/web/src/components/chat/ask-takeover.tsx):
 * question body + option cards (label/description, checkbox semantics for
 * multiSelect), pinned Submit / Skip. Rendered ABOVE the message list; the
 * regular composer stays available and doubles as the free-text "Other"
 * answer path (the host screen routes Send through the resolution API).
 */
export function RequestDock({
  question,
  parsed,
  onSubmit,
  onSkip,
}: {
  question: Message;
  parsed: ParsedRequest;
  onSubmit: (answer: string) => void;
  onSkip: () => void;
}) {
  const options = parsed.request.options ?? [];
  const multiSelect = parsed.request.multiSelect === true;
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const act = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  return (
    <View style={styles.dock}>
      <ScrollView style={styles.scroll} nestedScrollEnabled bounces={false}>
        <Text style={styles.kicker}>Asked you</Text>
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
                  style={({ pressed }) => [
                    styles.option,
                    isSelected && styles.optionSelected,
                    pressed && styles.pressed,
                  ]}
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
      <View style={styles.footer}>
        {options.length > 0 && (
          <Pressable
            onPress={() => {
              const labels = selected.map((i) => options[i]?.label).filter(Boolean).join(", ");
              if (labels) act(() => Promise.resolve(onSubmit(labels)));
            }}
            disabled={busy || (!multiSelect && selected.length === 0)}
            style={({ pressed }) => [
              styles.button,
              styles.primaryButton,
              styles.flex1,
              (busy || (!multiSelect && selected.length === 0)) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.accentText} />
            ) : (
              <Text style={styles.primaryButtonText}>Submit</Text>
            )}
          </Pressable>
        )}
        <Pressable
          onPress={() => act(() => Promise.resolve(onSkip()))}
          disabled={busy}
          style={({ pressed }) => [
            styles.button,
            styles.secondaryButton,
            styles.flex1,
            busy && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.secondaryButtonText}>Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    maxHeight: 260,
    backgroundColor: colors.surfaceStrong,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  scroll: {
    flexGrow: 0,
  },
  kicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
    marginBottom: 4,
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
  footer: {
    flexDirection: "row",
    gap: 8,
  },
  flex1: {
    flex: 1,
  },
  button: {
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 9,
    paddingHorizontal: 14,
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
  pressed: {
    opacity: 0.75,
  },
  disabled: {
    opacity: 0.45,
  },
});
