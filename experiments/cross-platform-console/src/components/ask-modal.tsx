import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { LiveMarkdownInput } from "~/components/live-markdown-input";
import { MarkdownText } from "~/components/markdown-text";
import {
  askAgentForClarification,
  fetchOpenRequests,
  fetchRequestThread,
  parseAskRequest,
  resolveAskRequest,
} from "~/lib/ask";
import { useAuth } from "~/lib/auth-context";
import { colors } from "~/lib/theme";

export function AskModal({ chatId, requestId }: { chatId: string; requestId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { agentId: selfAgentId } = useAuth();
  // Web parity (`ask-takeover.tsx`): answering and asking the agent are two
  // surfaces, not two tabs. Ask-agent mode replaces the answer surface so the
  // reply box and the question box never compete for the same footer actions.
  const [askAgentOpen, setAskAgentOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [clarification, setClarification] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openRequestsQuery = useQuery({
    queryKey: ["chats", chatId, "open-requests"],
    queryFn: ({ signal }) => fetchOpenRequests(chatId, signal),
    refetchInterval: 30_000,
  });

  const question = useMemo(
    () => openRequestsQuery.data?.find((message) => message.id === requestId) ?? null,
    [openRequestsQuery.data, requestId],
  );
  const parsed = question ? parseAskRequest(question) : null;
  // The ask IS the message body. The web renders it whole as markdown; this
  // used to run a splitter that cut it into "decision" / "recommendation" /
  // "context", which dropped most of the agent's message and left broken
  // markdown (`option 1**`) in what survived.
  const rawContent = typeof question?.content === "string" ? question.content : "";

  const threadQuery = useQuery({
    queryKey: ["chats", chatId, "request-thread", requestId],
    queryFn: ({ signal }) => fetchRequestThread(chatId, requestId, signal),
    enabled: question !== null,
    refetchInterval: 30_000,
  });
  const thread = useMemo(
    () => (threadQuery.data ?? []).filter((message) => message.id !== requestId),
    [requestId, threadQuery.data],
  );

  useEffect(() => {
    if (openRequestsQuery.isSuccess && !openRequestsQuery.isFetching && question === null && !advancing) {
      router.back();
    }
  }, [advancing, openRequestsQuery.isFetching, openRequestsQuery.isSuccess, question, router]);

  const advance = useCallback(async () => {
    setAdvancing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "open-requests"] });
      await queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
      const remaining = await fetchOpenRequests(chatId);
      queryClient.setQueryData(["chats", chatId, "open-requests"], remaining);
      const next = remaining.find((message) => message.id !== requestId);
      if (next) {
        router.replace({
          pathname: "/ask/[requestId]",
          params: { chatId, requestId: next.id },
        } as never);
      } else {
        router.back();
      }
    } catch (err) {
      setAdvancing(false);
      setError(err instanceof Error ? err.message : "Could not load the next question");
    }
  }, [chatId, queryClient, requestId, router]);

  const submit = useCallback(async () => {
    if (!question || !parsed) return;
    const labels = selected
      .map((index) => parsed.request.options?.[index]?.label)
      .filter(Boolean)
      .join(", ");
    const content = [labels, answer.trim()].filter(Boolean).join("\n\n");
    if (!content) return;

    setSubmitting(true);
    setError(null);
    try {
      await resolveAskRequest(chatId, question, "answered", content);
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
      await advance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the answer");
    } finally {
      setSubmitting(false);
    }
  }, [advance, answer, chatId, parsed, question, queryClient, selected]);

  const skip = useCallback(async () => {
    if (!question) return;
    setSubmitting(true);
    setError(null);
    try {
      await resolveAskRequest(chatId, question, "closed", "");
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
      await advance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't skip the question");
    } finally {
      setSubmitting(false);
    }
  }, [advance, chatId, question, queryClient]);

  const askAgent = useCallback(async () => {
    if (!question || !clarification.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await askAgentForClarification(chatId, requestId, clarification.trim());
      setClarification("");
      setAskAgentOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
      await queryClient.invalidateQueries({
        queryKey: ["chats", chatId, "request-thread", requestId],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the clarification");
    } finally {
      setSubmitting(false);
    }
  }, [chatId, clarification, queryClient, requestId, question]);

  if (openRequestsQuery.isLoading || !parsed) {
    return (
      <View style={[styles.overlay, styles.loading]}>
        {openRequestsQuery.isError ? (
          <Text style={styles.errorText}>Couldn't load this question.</Text>
        ) : (
          <ActivityIndicator color={colors.accent} />
        )}
      </View>
    );
  }

  const options = parsed.request.options ?? [];
  const multi = parsed.request.multiSelect === true;
  const busy = submitting || advancing;
  // Web parity: with options, a selection answers it; the note is optional.
  // Without options, the note IS the answer.
  const canSubmit = !busy && (options.length === 0 ? answer.trim().length > 0 : selected.length > 0);
  const canAskAgent = !busy && clarification.trim().length > 0;

  const toggleOption = (index: number) => {
    setSelected((current) => {
      if (parsed.request.multiSelect) {
        return current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort();
      }
      return current.includes(index) ? [] : [index];
    });
  };

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={() => router.back()} accessibilityLabel="Show the chat" />
      <KeyboardAvoidingView
        style={styles.sheetWrap}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.sheet}>
          <View style={styles.grabber} />

          {/* One scroller for the ask AND the answer surface, exactly as the
              web card does it: when the sheet is shorter than its contents the
              whole region scrolls while the actions below stay pinned, so
              Submit is reachable at any height. */}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            <View style={styles.header}>
              <Text style={styles.kicker}>Question for you</Text>
              <Pressable onPress={() => router.back()} hitSlop={12} style={styles.headerLink}>
                <Ionicons name="time-outline" size={14} color={colors.textMuted} />
                <Text style={styles.headerLinkText}>Show chat</Text>
              </Pressable>
            </View>

            {/* The ask, whole, as the agent wrote it. */}
            <MarkdownText value={rawContent || "The agent did not provide a question."} />

            {thread.length > 0 && (
              <View style={styles.threadBlock}>
                {thread.map((entry) => (
                  <View key={entry.id} style={styles.threadEntry}>
                    <Text style={styles.threadAuthor}>
                      {entry.senderId === selfAgentId ? "You asked the agent" : "Agent response"}
                    </Text>
                    <MarkdownText value={typeof entry.content === "string" ? entry.content : ""} />
                  </View>
                ))}
              </View>
            )}

            <View style={styles.answerSurface}>
              {askAgentOpen ? (
                <>
                  <Text style={styles.surfaceLabel}>What would you like the agent to clarify?</Text>
                  <LiveMarkdownInput
                    value={clarification}
                    onChangeText={setClarification}
                    placeholder="Ask a focused question about the context above…"
                    placeholderTextColor={colors.textMuted}
                    multiline
                    maxLength={4000}
                    returnKeyType="send"
                    submitBehavior="submit"
                    onSubmitEditing={() => void askAgent()}
                  />
                </>
              ) : (
                <>
                  {options.length > 0 && (
                    <View style={styles.options}>
                      {options.map((option, index) => {
                        const isSelected = selected.includes(index);
                        return (
                          <Pressable
                            key={`${option.label}-${option.description ?? ""}`}
                            accessibilityRole={multi ? "checkbox" : "radio"}
                            accessibilityState={{ checked: isSelected }}
                            onPress={() => toggleOption(index)}
                            style={({ pressed }) => [
                              styles.option,
                              isSelected && styles.optionSelected,
                              pressed && styles.pressed,
                            ]}
                          >
                            <View
                              style={[
                                styles.choiceGlyph,
                                multi && styles.choiceGlyphSquare,
                                isSelected && styles.choiceGlyphActive,
                              ]}
                            >
                              {isSelected && <Ionicons name="checkmark" size={13} color={colors.accentText} />}
                            </View>
                            <View style={styles.optionText}>
                              <Text style={styles.optionLabel}>{option.label}</Text>
                              {option.description ? (
                                <Text style={styles.optionDescription}>{option.description}</Text>
                              ) : null}
                              {/* Web parity: the preview is the option's
                                  evidence, and only earns its space once that
                                  option is the one being chosen. */}
                              {isSelected && option.preview ? (
                                <Text style={styles.optionPreview}>{option.preview}</Text>
                              ) : null}
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}

                  {/* Always present, never behind a disclosure: with options it
                      is the "something else" answer, without them it is the
                      answer. */}
                  <LiveMarkdownInput
                    value={answer}
                    onChangeText={setAnswer}
                    placeholder={options.length > 0 ? "Other (type your own)…" : "Type your answer…"}
                    placeholderTextColor={colors.textMuted}
                    multiline
                    maxLength={4000}
                    returnKeyType={options.length === 0 ? "send" : "done"}
                    submitBehavior={options.length === 0 ? "submit" : undefined}
                    onSubmitEditing={() => {
                      if (options.length === 0) void submit();
                    }}
                  />
                </>
              )}

              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>
          </ScrollView>

          {/* Pinned actions — Skip / Ask agent / Submit, like the web footer. */}
          <View style={styles.footer}>
            {askAgentOpen ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAskAgentOpen(false)}
                  disabled={busy}
                  style={({ pressed }) => [styles.ghostButton, busy && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={styles.ghostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void askAgent()}
                  disabled={!canAskAgent}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    !canAskAgent && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {submitting ? (
                    <ActivityIndicator color={colors.accentText} size="small" />
                  ) : (
                    <Text style={styles.primaryText}>Ask agent</Text>
                  )}
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void skip()}
                  disabled={busy}
                  style={({ pressed }) => [styles.ghostButton, busy && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={styles.ghostText}>Skip</Text>
                </Pressable>
                <View style={styles.footerSpacer} />
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAskAgentOpen(true)}
                  disabled={busy}
                  style={({ pressed }) => [styles.secondaryButton, busy && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>Ask agent</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void submit()}
                  disabled={!canSubmit}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    !canSubmit && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.accentText} size="small" />
                  ) : (
                    <Text style={styles.primaryText}>{options.length > 0 ? "Submit" : "Send answer"}</Text>
                  )}
                </Pressable>
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheetWrap: {
    justifyContent: "flex-end",
  },
  // The sheet grows with its contents up to a ceiling instead of being handed
  // a fixed fraction of the screen its contents may not fit in.
  sheet: {
    maxHeight: "90%",
    backgroundColor: colors.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  loading: {
    alignItems: "center",
    justifyContent: "center",
  },
  grabber: {
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 2,
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  scroll: {
    flexShrink: 1,
  },
  scrollContent: {
    gap: 14,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  kicker: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  headerLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  headerLinkText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
  },
  threadBlock: {
    gap: 8,
  },
  threadEntry: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    gap: 4,
    padding: 12,
  },
  threadAuthor: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  answerSurface: {
    gap: 10,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  surfaceLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  options: {
    gap: 8,
  },
  option: {
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  optionSelected: {
    backgroundColor: "rgba(59,130,246,0.14)",
    borderColor: colors.accent,
  },
  choiceGlyph: {
    alignItems: "center",
    borderColor: colors.border,
    borderWidth: 1.5,
    borderRadius: 11,
    height: 22,
    justifyContent: "center",
    marginTop: 1,
    width: 22,
  },
  choiceGlyphSquare: {
    borderRadius: 6,
  },
  choiceGlyphActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  optionText: {
    flex: 1,
    gap: 3,
  },
  optionLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20,
  },
  optionDescription: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  optionPreview: {
    marginTop: 6,
    padding: 8,
    borderRadius: 8,
    backgroundColor: colors.bg,
    color: colors.textMuted,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    lineHeight: 17,
  },
  footer: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  footerSpacer: {
    flex: 1,
  },
  ghostButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  ghostText: {
    color: colors.textSecondary,
    fontSize: 15,
    fontWeight: "600",
  },
  secondaryButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  secondaryText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    minWidth: 116,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: colors.accent,
  },
  primaryText: {
    color: colors.accentText,
    fontSize: 15,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.8,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
  },
});
