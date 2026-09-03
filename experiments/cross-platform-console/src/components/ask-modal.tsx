import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
  const insets = useSafeAreaInsets();
  // Same deterministic keyboard handling the composer uses: lift by the exact
  // keyboard height. KeyboardAvoidingView mis-measures inside a native modal
  // and left the action row behind the keyboard.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const show = Keyboard.addListener("keyboardDidShow", (event) => setKeyboardHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
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
      <View style={styles.loading}>
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

  // A phone is not a desktop with a centred card: a blocking decision with a
  // long body, its options and a free-text answer IS the screen. Full height
  // with a fixed bar top and bottom also gives the scroller a definite height
  // to live in — a self-sizing sheet does not, which is why its contents kept
  // ending up under the actions.
  return (
    <View style={[styles.screen, { paddingBottom: keyboardHeight }]}>
      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <Text style={styles.kicker}>Question for you</Text>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.headerLink}>
          <Text style={styles.headerLinkText}>Show chat</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
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
              <View style={styles.field}>
                <LiveMarkdownInput
                  value={clarification}
                  onChangeText={setClarification}
                  placeholder="Ask a focused question about the context above…"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  minLines={3}
                  maxLines={5}
                  maxLength={4000}
                  returnKeyType="send"
                  submitBehavior="submit"
                  onSubmitEditing={() => void askAgent()}
                />
              </View>
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
              <View style={styles.field}>
                <LiveMarkdownInput
                  value={answer}
                  onChangeText={setAnswer}
                  placeholder={options.length > 0 ? "Other (type your own)…" : "Type your answer…"}
                  placeholderTextColor={colors.textMuted}
                  multiline
                  // Web parity: a bare "Other" line beside options, a real
                  // writing surface when the answer is only text.
                  minLines={options.length > 0 ? 1 : 3}
                  maxLines={options.length > 0 ? 4 : 6}
                  maxLength={4000}
                  returnKeyType={options.length === 0 ? "send" : "done"}
                  submitBehavior={options.length === 0 ? "submit" : undefined}
                  onSubmitEditing={() => {
                    if (options.length === 0) void submit();
                  }}
                />
              </View>
            </>
          )}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>
      </ScrollView>

      {/* Sticky action bar. Outside the scroller, so it is reachable no matter
          how long the ask is. */}
      <View style={[styles.footer, { paddingBottom: keyboardHeight > 0 ? 12 : insets.bottom + 12 }]}>
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
              style={({ pressed }) => [styles.primaryButton, !canSubmit && styles.disabled, pressed && styles.pressed]}
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
  );
}

const styles = StyleSheet.create({
  // Full screen, three bands: fixed bar, one scroller, fixed action bar. The
  // scroller is the only flexible band, and it is bounded by the screen — the
  // guarantee a self-sizing sheet could never give it.
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  field: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 14,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  // `maxHeight: "90%"` only means anything against a parent with a definite
  // height. Without this the sheet grew past the screen and its scroller never
  // shrank, which is how the answer field ended up under the action row.
  // The sheet grows with its contents up to a ceiling instead of being handed
  // a fixed fraction of the screen its contents may not fit in.
  loading: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
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
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  footerSpacer: {
    flex: 1,
  },
  // One filled action, one quiet one, and a plain text out. Three filled
  // slabs competing at the same weight was the "ugly" part.
  ghostButton: {
    alignItems: "center",
    justifyContent: "center",
    height: 40,
    paddingHorizontal: 10,
  },
  ghostText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: "500",
  },
  secondaryButton: {
    alignItems: "center",
    justifyContent: "center",
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  secondaryText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
  },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    height: 40,
    paddingHorizontal: 20,
    borderRadius: 20,
    backgroundColor: colors.accent,
  },
  primaryText: {
    color: colors.accentText,
    fontSize: 15,
    fontWeight: "600",
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
