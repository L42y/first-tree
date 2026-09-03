import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
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

export function AskModal({ chatId, requestId }: { chatId: string; requestId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { agentId: selfAgentId } = useAuth();
  const insets = useSafeAreaInsets();
  // Pull the sheet down to dismiss, the same gesture the participants sheet
  // uses: the grabber area claims a clear downward drag, and the body only
  // dismisses through overscroll once it has no scrolling left to do.
  const dragY = useRef(new Animated.Value(0)).current;
  const settle = useCallback(() => {
    Animated.spring(dragY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
  }, [dragY]);
  const dismiss = useCallback(() => {
    Animated.timing(dragY, { toValue: 700, duration: 160, useNativeDriver: true }).start(() => router.back());
  }, [dragY, router]);
  const headerDrag = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 4 && gesture.dy > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          if (gesture.dy > 0) dragY.setValue(gesture.dy);
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 90 || gesture.vy > 0.8) dismiss();
          else settle();
        },
        onPanResponderTerminate: settle,
      }),
    [dismiss, dragY, settle],
  );

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

  // Shaped like the participants sheet, because that is the shape that works
  // here: a bottom sheet capped against a full-height parent, and everything
  // in one scroller. Skip and Show chat are header actions — the two ways out
  // — while the input carries the two ways forward, so nothing is pinned to
  // the bottom edge fighting the keyboard.
  return (
    <View style={[styles.overlay, { paddingBottom: keyboardHeight }]}>
      <Pressable style={styles.backdrop} onPress={() => router.back()} accessibilityLabel="Show the chat" />
      <Animated.View style={[styles.sheet, { transform: [{ translateY: dragY }] }]}>
        <View {...headerDrag.panHandlers}>
          <View style={styles.grabber} />
          <View style={styles.topBar}>
            <Text style={styles.kicker}>Question for you</Text>
            <View style={styles.topActions}>
              {/* Skip resolves the question without answering, so it belongs
                  with the other ways out — not next to the send action. */}
              <Pressable
                onPress={() => void skip()}
                disabled={busy}
                hitSlop={8}
                style={({ pressed }) => [styles.headerLink, busy && styles.disabled, pressed && styles.pressed]}
              >
                <Text style={styles.headerLinkText}>Skip</Text>
              </Pressable>
              <Pressable
                onPress={() => router.back()}
                hitSlop={8}
                style={({ pressed }) => [styles.headerLink, pressed && styles.pressed]}
              >
                <Text style={styles.headerLinkText}>Show chat</Text>
              </Pressable>
            </View>
          </View>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          scrollEventThrottle={16}
          onScroll={({ nativeEvent }) => dragY.setValue(Math.max(0, -nativeEvent.contentOffset.y))}
          onScrollEndDrag={({ nativeEvent }) => {
            if (nativeEvent.contentOffset.y < -80) dismiss();
            else settle();
          }}
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

          {!askAgentOpen && options.length > 0 && (
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

          {/* What the input is for, sitting on it: answering the question, or
              asking the agent about it. Two destinations for one box beats two
              buttons competing for the same box. */}
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

          {/* The chat's own composer, not a second input that behaves
              differently. */}
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
            minLines={askAgentOpen || options.length === 0 ? 3 : 1}
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
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Same shell as the participants sheet: a full-height overlay gives the
  // sheet's percentage cap something definite to resolve against, and the
  // sheet grows with its contents until it hits that cap.
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
  sheet: {
    maxHeight: "88%",
    backgroundColor: colors.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: "hidden",
  },
  grabber: {
    alignSelf: "center",
    marginTop: 8,
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
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
    flexShrink: 1,
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
  topActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
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
