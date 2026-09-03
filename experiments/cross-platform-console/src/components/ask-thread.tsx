import Ionicons from "@expo/vector-icons/Ionicons";
import type { Message } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ComposerField } from "~/components/composer-field";
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

/**
 * An ask, as a thread on the message it belongs to — the shape Slack uses: the
 * question stays in the conversation, its clarifications and its answer hang
 * off it as replies, and the reply box belongs to the thread rather than to a
 * sheet floating over the chat. One implementation serves both places it is
 * read: inline under the message in the timeline, and on its own screen when
 * opened from the dock or a notification.
 */
export function AskThread({
  chatId,
  requestId,
  question: questionProp,
  onResolved,
}: {
  chatId: string;
  requestId: string;
  /** The request message when the caller already has it (timeline embed). */
  question?: Message;
  onResolved?: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { agentId: selfAgentId } = useAuth();
  // Answering and asking the agent are two destinations for one reply box.
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
    enabled: questionProp == null,
    refetchInterval: 30_000,
  });

  const question = useMemo(
    () => questionProp ?? openRequestsQuery.data?.find((message) => message.id === requestId) ?? null,
    [openRequestsQuery.data, questionProp, requestId],
  );
  // An embedded thread renders under a message that is already on screen, so
  // it never navigates and never chases the next open ask.
  const embedded = questionProp != null;
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
    if (embedded) return;
    if (openRequestsQuery.isSuccess && !openRequestsQuery.isFetching && question === null && !advancing) {
      router.back();
    }
  }, [advancing, embedded, openRequestsQuery.isFetching, openRequestsQuery.isSuccess, question, router]);

  // After a resolution: an embedded thread settles in place under its message,
  // while the standalone screen moves on to the next open ask — the reason it
  // was opened was to clear them.
  const advance = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "open-requests"] });
    await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "request-thread", requestId] });
    await queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
    if (embedded) {
      onResolved?.();
      return;
    }
    setAdvancing(true);
    try {
      const remaining = await fetchOpenRequests(chatId);
      queryClient.setQueryData(["chats", chatId, "open-requests"], remaining);
      const next = remaining.find((message) => message.id !== requestId);
      if (next) {
        router.replace({ pathname: "/ask/[requestId]", params: { chatId, requestId: next.id } } as never);
      } else {
        router.back();
      }
    } catch (err) {
      setAdvancing(false);
      setError(err instanceof Error ? err.message : "Could not load the next question");
    }
  }, [chatId, embedded, onResolved, queryClient, requestId, router]);

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

  if (!parsed) {
    if (embedded) return null;
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
  // Embedded in the timeline the thread outlives its answer, so it has to be
  // able to show that it was answered rather than keep offering a reply box.
  const resolved = thread.some(
    (entry) => (entry.metadata?.resolves as { request?: unknown } | undefined)?.request === requestId,
  );

  const toggleOption = (index: number) => {
    setSelected((current) => {
      if (parsed.request.multiSelect) {
        return current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort();
      }
      return current.includes(index) ? [] : [index];
    });
  };

  return (
    <View style={styles.thread}>
      {/* The ask itself. In the timeline this replaces the plain bubble, so
          the question and everything hanging off it read as one unit. */}
      <View style={styles.askCard}>
        <View style={styles.askHead}>
          <Ionicons name="help-circle-outline" size={15} color={colors.accent} />
          <Text style={styles.kicker}>Question for you</Text>
          <View style={styles.spacer} />
          {!resolved && (
            <Pressable
              onPress={() => void skip()}
              disabled={busy}
              hitSlop={8}
              style={({ pressed }) => [styles.headerLink, busy && styles.disabled, pressed && styles.pressed]}
            >
              <Text style={styles.headerLinkText}>Skip</Text>
            </Pressable>
          )}
        </View>
        <MarkdownText value={rawContent || "The agent did not provide a question."} />
      </View>

      {/* Replies, as replies: indented under the ask, oldest first. */}
      {thread.length > 0 && (
        <View style={styles.replies}>
          {thread.map((entry) => (
            <View key={entry.id} style={styles.reply}>
              <Text style={styles.replyAuthor}>{entry.senderId === selfAgentId ? "You" : "Agent"}</Text>
              <MarkdownText value={typeof entry.content === "string" ? entry.content : ""} />
            </View>
          ))}
        </View>
      )}

      {resolved ? (
        <View style={styles.resolvedRow}>
          <Ionicons name="checkmark-circle" size={15} color={colors.textMuted} />
          <Text style={styles.resolvedText}>Answered</Text>
        </View>
      ) : (
        <View style={styles.replyBox}>
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
                      {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
                      {isSelected && option.preview ? <Text style={styles.optionPreview}>{option.preview}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Where the reply goes: to the question, or to the agent about it. */}
          <View style={styles.tabs}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: !askAgentOpen }}
              onPress={() => setAskAgentOpen(false)}
              style={({ pressed }) => [styles.tab, !askAgentOpen && styles.tabActive, pressed && styles.pressed]}
            >
              <Text style={[styles.tabText, !askAgentOpen && styles.tabTextActive]}>Answer</Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: askAgentOpen }}
              onPress={() => setAskAgentOpen(true)}
              style={({ pressed }) => [styles.tab, askAgentOpen && styles.tabActive, pressed && styles.pressed]}
            >
              <Text style={[styles.tabText, askAgentOpen && styles.tabTextActive]}>Ask agent</Text>
            </Pressable>
          </View>

          <ComposerField
            trailing={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={askAgentOpen ? "Ask agent" : "Send answer"}
                onPress={() => void (askAgentOpen ? askAgent() : submit())}
                disabled={askAgentOpen ? !canAskAgent : !canSubmit}
                style={({ pressed }) => [
                  styles.sendButton,
                  (askAgentOpen ? !canAskAgent : !canSubmit) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.accentText} size="small" />
                ) : (
                  <Ionicons name="arrow-up" size={18} color={colors.accentText} />
                )}
              </Pressable>
            }
            value={askAgentOpen ? clarification : answer}
            onChangeText={askAgentOpen ? setClarification : setAnswer}
            placeholder={
              askAgentOpen
                ? "Ask a focused question…"
                : options.length > 0
                  ? "Other (type your own)…"
                  : "Type your answer…"
            }
            multiline
            minLines={1}
            maxLines={5}
            maxLength={4000}
            returnKeyType={askAgentOpen || options.length === 0 ? "send" : "done"}
            submitBehavior={askAgentOpen || options.length === 0 ? "submit" : undefined}
            onSubmitEditing={() => {
              if (askAgentOpen) void askAgent();
              else if (options.length === 0) void submit();
            }}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // A thread, not a panel: the ask reads as the message it is, its replies sit
  // indented under it, and the reply box belongs to the thread.
  thread: {
    gap: 8,
    paddingVertical: 4,
  },
  askCard: {
    gap: 6,
    padding: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  askHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  spacer: {
    flex: 1,
  },
  replies: {
    gap: 8,
    marginLeft: 12,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  reply: {
    gap: 2,
  },
  replyAuthor: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  replyBox: {
    gap: 10,
    marginLeft: 12,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  resolvedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginLeft: 24,
  },
  resolvedText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
  },
  // Same shell as the participants sheet: a full-height overlay gives the
  // sheet's percentage cap something definite to resolve against, and the
  // sheet grows with its contents until it hits that cap.
  // `maxHeight: "90%"` only means anything against a parent with a definite
  // height. Without this the sheet grew past the screen and its scroller never
  // shrank, which is how the answer field ended up under the action row.
  // The sheet grows with its contents up to a ceiling instead of being handed
  // a fixed fraction of the screen its contents may not fit in.
  loading: {
    paddingVertical: 24,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
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
  options: {
    gap: 8,
  },
  tabs: {
    flexDirection: "row",
    alignSelf: "flex-start",
    gap: 4,
    padding: 3,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 9,
  },
  tabActive: {
    backgroundColor: colors.surfaceStrong,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: "600",
  },
  tabTextActive: {
    color: colors.text,
  },
  sendButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    borderRadius: 17,
    marginBottom: 3,
    backgroundColor: colors.accent,
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
  // One filled action, one quiet one, and a plain text out. Three filled
  // slabs competing at the same weight was the "ugly" part.
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

/**
 * The same thread on its own screen — what the dock and notifications open.
 * A pushed screen rather than a sheet: a thread is a place you go, and the
 * back gesture is how you leave it.
 */
export function AskThreadScreen({ chatId, requestId }: { chatId: string; requestId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={screenStyles.screen}>
      <View style={[screenStyles.header, { paddingTop: insets.top + 6 }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={screenStyles.back}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
        <Text style={screenStyles.title}>Thread</Text>
      </View>
      <ScrollView
        contentContainerStyle={[screenStyles.body, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <AskThread chatId={chatId} requestId={requestId} />
      </ScrollView>
    </View>
  );
}

const screenStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceStrong,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  body: {
    padding: 16,
  },
});
