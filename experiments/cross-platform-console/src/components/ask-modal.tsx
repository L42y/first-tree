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
import { buildAskPresentation } from "~/lib/ask-presentation";
import { useAuth } from "~/lib/auth-context";
import { colors } from "~/lib/theme";

type AskMode = "answer" | "clarify";

export function AskModal({ chatId, requestId }: { chatId: string; requestId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { agentId: selfAgentId } = useAuth();
  const [mode, setMode] = useState<AskMode>("answer");
  const [answer, setAnswer] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [showThread, setShowThread] = useState(false);

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
  const rawContent = typeof question?.content === "string" ? question.content : "";
  const presentation = useMemo(() => buildAskPresentation(rawContent), [rawContent]);
  const contextText =
    presentation.context.length > 0 ? presentation.context.join("\n\n") : presentation.hasMore ? rawContent : null;

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
    if (!question || !answer.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await askAgentForClarification(chatId, requestId, answer.trim());
      setAnswer("");
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
      await queryClient.invalidateQueries({
        queryKey: ["chats", chatId, "request-thread", requestId],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the clarification");
    } finally {
      setSubmitting(false);
    }
  }, [answer, chatId, queryClient, requestId, question]);

  if (openRequestsQuery.isLoading || !parsed) {
    return (
      <View style={[styles.sheet, styles.loading]}>
        {openRequestsQuery.isError ? (
          <Text style={styles.errorText}>Couldn't load this question.</Text>
        ) : (
          <ActivityIndicator color={colors.accent} />
        )}
      </View>
    );
  }

  const options = parsed.request.options ?? [];
  const isClarify = mode === "clarify";
  const hasSelection = selected.length > 0;
  const canSubmitAnswer = options.length === 0 ? answer.trim().length > 0 : hasSelection;
  const canSubmit = submitting || advancing ? false : isClarify ? answer.trim().length > 0 : canSubmitAnswer;

  const toggleOption = (index: number) => {
    setSelected((current) => {
      if (parsed.request.multiSelect) {
        return current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort();
      }
      return current.includes(index) ? [] : [index];
    });
  };

  return (
    <KeyboardAvoidingView
      style={styles.sheet}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.content}>
        {/* One heading, not three: the kicker says what this is, the question
            says what it asks. "You need to choose" above the question was a
            third line of chrome saying neither. */}
        <View style={styles.header}>
          <Text style={styles.kicker}>{isClarify ? "Ask about this decision" : "Decision needed"}</Text>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.closeButton}>
            <Ionicons name="close" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <Text style={styles.questionText}>{presentation.decision || "The agent did not provide a question."}</Text>

          {presentation.recommendation ? (
            <View style={styles.recommendation}>
              <Text style={styles.recommendationLabel}>Recommended</Text>
              <Text style={styles.recommendationText}>{presentation.recommendation}</Text>
            </View>
          ) : null}

          <View style={styles.modeTabs}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: !isClarify }}
              onPress={() => setMode("answer")}
              style={({ pressed }) => [styles.modeTab, !isClarify && styles.modeTabActive, pressed && styles.pressed]}
            >
              <Text style={[styles.modeTabText, !isClarify && styles.modeTabTextActive]}>Answer</Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: isClarify }}
              onPress={() => setMode("clarify")}
              style={({ pressed }) => [styles.modeTab, isClarify && styles.modeTabActive, pressed && styles.pressed]}
            >
              <Text style={[styles.modeTabText, isClarify && styles.modeTabTextActive]}>Clarification</Text>
            </Pressable>
          </View>

          {!isClarify && options.length > 0 && (
            <View style={styles.options}>
              {options.map((option, index) => {
                const isSelected = selected.includes(index);
                return (
                  <Pressable
                    key={`${option.label}-${option.description ?? ""}`}
                    accessibilityRole={parsed.request.multiSelect ? "checkbox" : "radio"}
                    accessibilityState={{ checked: isSelected }}
                    onPress={() => toggleOption(index)}
                    style={({ pressed }) => [
                      styles.option,
                      isSelected && styles.optionSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={[styles.choiceGlyph, isSelected && styles.choiceGlyphActive]}>
                      <Ionicons
                        name={
                          isSelected ? (parsed.request.multiSelect ? "checkmark" : "checkmark") : "radio-button-off"
                        }
                        size={14}
                        color={isSelected ? colors.accentText : colors.textMuted}
                      />
                    </View>
                    <View style={styles.optionText}>
                      <Text style={styles.optionLabel}>{option.label}</Text>
                      {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          {!isClarify && options.length > 0 && !noteOpen && (
            <Pressable
              onPress={() => setNoteOpen(true)}
              style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}
            >
              <Ionicons name="add" size={14} color={colors.accent} />
              <Text style={styles.inlineActionText}>Add details</Text>
            </Pressable>
          )}

          {(isClarify || options.length === 0 || noteOpen) && (
            <LiveMarkdownInput
              value={answer}
              onChangeText={setAnswer}
              placeholder={
                isClarify
                  ? "Ask the agent for clarification…"
                  : options.length === 0
                    ? "Type your answer…"
                    : "Add optional details…"
              }
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={4000}
              returnKeyType={isClarify ? "send" : options.length === 0 ? "send" : "done"}
              submitBehavior={isClarify || options.length === 0 ? "submit" : undefined}
              onSubmitEditing={() => {
                if (isClarify) void askAgent();
                else if (options.length === 0) void submit();
              }}
            />
          )}

          {(contextText || thread.length > 0) && (
            <View style={styles.secondary}>
              {contextText && (
                <View style={styles.secondaryRow}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setShowContext((visible) => !visible)}
                    style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
                  >
                    <Ionicons name={showContext ? "chevron-up" : "chevron-down"} size={14} color={colors.textMuted} />
                    <Text style={styles.secondaryActionText}>Background</Text>
                  </Pressable>
                  {showContext && (
                    <View style={styles.context}>
                      <MarkdownText value={contextText} />
                    </View>
                  )}
                </View>
              )}

              {thread.length > 0 && (
                <View style={styles.secondaryRow}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setShowThread((visible) => !visible)}
                    style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
                  >
                    <Ionicons name={showThread ? "chevron-up" : "chevron-down"} size={14} color={colors.textMuted} />
                    <Text style={styles.secondaryActionText}>Clarification ({thread.length})</Text>
                  </Pressable>
                  {showThread &&
                    thread.map((entry) => (
                      <View key={entry.id} style={styles.threadEntry}>
                        <Text style={styles.threadAuthor}>{entry.senderId === selfAgentId ? "You" : "Agent"}</Text>
                        <MarkdownText value={typeof entry.content === "string" ? entry.content : ""} />
                      </View>
                    ))}
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.footer}>
          {!isClarify ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void skip()}
              disabled={submitting || advancing}
              style={({ pressed }) => [
                styles.skipButton,
                (submitting || advancing) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.skipText}>Skip</Text>
            </Pressable>
          ) : (
            <View />
          )}

          <Pressable
            accessibilityRole="button"
            onPress={() => void (isClarify ? askAgent() : submit())}
            disabled={!canSubmit}
            style={({ pressed }) => [styles.primaryButton, !canSubmit && styles.disabled, pressed && styles.pressed]}
          >
            {submitting || advancing ? (
              <ActivityIndicator color={colors.accentText} size="small" />
            ) : (
              <Text style={styles.primaryText}>
                {isClarify ? "Send clarification" : options.length > 0 ? "Submit choice" : "Send answer"}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
    // A flex child's default `minHeight: auto` lets it keep its content height
    // instead of shrinking, which is how a half-height sheet ended up painting
    // the question over the header and the Skip button over the input.
    minHeight: 0,
    gap: 14,
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 16,
  },
  loading: {
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 0,
    gap: 12,
    justifyContent: "space-between",
  },
  kicker: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 17,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  scroll: {
    flex: 1,
    flexShrink: 1,
    minHeight: 0,
  },
  scrollContent: {
    gap: 14,
    paddingBottom: 12,
  },
  questionText: {
    color: colors.text,
    fontSize: 19,
    fontWeight: "700",
    lineHeight: 25,
  },
  recommendation: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  recommendationLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  recommendationText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  modeTabs: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    flexDirection: "row",
    gap: 4,
    padding: 4,
  },
  modeTab: {
    alignItems: "center",
    borderRadius: 10,
    flex: 1,
    paddingVertical: 10,
  },
  modeTabActive: {
    backgroundColor: colors.surfaceStrong,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 3,
  },
  modeTabText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: "700",
  },
  modeTabTextActive: {
    color: colors.text,
  },
  options: {
    gap: 10,
  },
  option: {
    alignItems: "center",
    backgroundColor: colors.surfaceStrong,
    borderColor: colors.border,
    borderRadius: 16,
    flexDirection: "row",
    gap: 12,
    minHeight: 62,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  optionSelected: {
    backgroundColor: "rgba(59,130,246,0.14)",
    borderColor: colors.accent,
  },
  choiceGlyph: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    height: 28,
    justifyContent: "center",
    width: 28,
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
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 21,
  },
  optionDescription: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  inlineAction: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  inlineActionText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "700",
  },
  secondary: {
    gap: 8,
  },
  secondaryRow: {
    gap: 6,
  },
  secondaryAction: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  secondaryActionText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: "700",
  },
  context: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 12,
  },
  threadEntry: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    gap: 5,
    marginTop: 6,
    padding: 12,
  },
  threadAuthor: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  footer: {
    flexShrink: 0,
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  skipButton: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  skipText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: "700",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 14,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  primaryText: {
    color: colors.accentText,
    fontSize: 15,
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.72,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
});
