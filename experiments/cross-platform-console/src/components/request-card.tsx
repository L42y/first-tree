import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { Message } from "@first-tree/shared";
import { MarkdownText } from "~/components/markdown-text";
import { colors } from "~/lib/theme";
import { findResolutionMessage, parseAskRequest, resolveAskRequest } from "~/lib/ask";

/**
 * Interactive card for `format="request"` messages ("ask user").
 *
 * Mirrors the web answer surface: option buttons or free text attach
 * `resolves kind="answered"`, Skip attaches `resolves kind="closed"`.
 * Only the targeted human can act — everyone else sees the read-only
 * state (open questions show a "waiting for <target>" note).
 */
export function RequestCard({
  chatId,
  message,
  messages,
  selfAgentId,
}: {
  chatId: string;
  message: Message;
  messages: Message[];
  selfAgentId: string | null;
}) {
  const parsed = parseAskRequest(message);
  const resolution = findResolutionMessage(messages, message.id) ?? null;
  const [selected, setSelected] = useState<number[]>([]);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!parsed) {
    // Malformed request payload — render the body as a plain card.
    return (
      <View style={styles.card}>
        <MarkdownText value={typeof message.content === "string" ? message.content : ""} />
      </View>
    );
  }

  const isTarget = selfAgentId !== null && parsed.targetAgentId === selfAgentId;
  const options = parsed.request.options ?? [];
  const multiSelect = parsed.request.multiSelect === true;

  const submit = async (kind: "answered" | "closed", content: string) => {
    setError(null);
    setSubmitting(true);
    try {
      await resolveAskRequest(chatId, message, kind, content);
      setDraft("");
      setSelected([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSubmitting(false);
    }
  };

  const submitSelected = () => {
    if (selected.length === 0) return;
    const labels = selected.map((i) => options[i]?.label).filter(Boolean).join(", ");
    void submit("answered", labels);
  };

  return (
    <View style={styles.wrap}>
      <View style={[styles.card, resolution ? styles.resolvedCard : styles.openCard]}>
        <Text style={styles.kicker}>{resolution ? "Question · answered" : isTarget ? "Asked you" : "Question"}</Text>
        <MarkdownText value={typeof message.content === "string" ? message.content : ""} />

        {!resolution && options.length > 0 && (
          <View style={styles.options}>
            {options.map((option, index) => {
              const isSelected = selected.includes(index);
              return (
                <Pressable
                  key={`${index}-${option.label}`}
                  disabled={!isTarget || submitting}
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
                    (!isTarget || submitting) && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>
                    {multiSelect && `${isSelected ? "☑" : "☐"} `}{option.label}
                  </Text>
                  {option.description ? (
                    <Text style={styles.optionDescription}>{option.description}</Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        )}

        {!resolution && error && <Text style={styles.error}>{error}</Text>}

        {isTarget && !resolution ? (
          <View style={styles.actions}>
            {options.length > 0 && (
              <Pressable
                onPress={submitSelected}
                disabled={submitting || selected.length === 0}
                style={({ pressed }) => [
                  styles.button,
                  styles.primaryButton,
                  (submitting || selected.length === 0) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={colors.accentText} />
                ) : (
                  <Text style={styles.primaryButtonText}>Submit</Text>
                )}
              </Pressable>
            )}
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Or write an answer…"
              placeholderTextColor={colors.textMuted}
              multiline
            />
            <View style={styles.row}>
              <Pressable
                onPress={() => draft.trim() && void submit("answered", draft.trim())}
                disabled={submitting || !draft.trim()}
                style={({ pressed }) => [
                  styles.button,
                  styles.primaryButton,
                  styles.flex1,
                  (submitting || !draft.trim()) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryButtonText}>Answer</Text>
              </Pressable>
              <Pressable
                onPress={() => void submit("closed", "")}
                disabled={submitting}
                style={({ pressed }) => [
                  styles.button,
                  styles.secondaryButton,
                  styles.flex1,
                  submitting && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.secondaryButtonText}>Skip</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {resolution ? (
          <Text style={styles.resolutionNote}>
            {(() => {
              const kind = (resolution.metadata?.resolves as { kind?: string } | undefined)?.kind;
              const body = typeof resolution.content === "string" ? resolution.content : "";
              return kind === "closed"
                ? body
                  ? `Skipped — ${body}`
                  : "Skipped"
                : body
                  ? `Answered — ${body}`
                  : "Answered";
            })()}
          </Text>
        ) : !isTarget ? (
          <Text style={styles.waitingNote}>Waiting for an answer</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  card: {
    flex: 1,
    borderRadius: 12,
    padding: 12,
    gap: 10,
    borderWidth: 1,
  },
  openCard: {
    backgroundColor: colors.surfaceStrong,
    borderColor: colors.accent,
  },
  resolvedCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    opacity: 0.85,
  },
  kicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
  },
  options: {
    gap: 8,
  },
  option: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: "rgba(59,130,246,0.18)",
  },
  optionLabel: {
    color: colors.text,
    fontWeight: "600",
  },
  optionLabelSelected: {
    color: colors.text,
  },
  optionDescription: {
    color: colors.textMuted,
    fontSize: 12,
  },
  actions: {
    gap: 8,
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  flex1: {
    flex: 1,
  },
  input: {
    minHeight: 38,
    maxHeight: 100,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  button: {
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
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
  error: {
    color: colors.danger,
    fontSize: 13,
  },
  resolutionNote: {
    color: colors.textMuted,
    fontSize: 13,
  },
  waitingNote: {
    color: colors.textMuted,
    fontSize: 13,
  },
});
