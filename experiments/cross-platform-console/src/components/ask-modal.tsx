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
  const [mode, setMode] = useState<"submit" | "clarify">("submit");
  const [answer, setAnswer] = useState("");
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
          pathname: "/chat/[chatId]/ask/[requestId]",
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
    const content = [labels, answer.trim()].filter(Boolean).join(" — ");
    if (!content) return;

    setSubmitting(true);
    setError(null);
    try {
      await resolveAskRequest(chatId, question, "answered", content);
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
      await advance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit answer");
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
      setError(err instanceof Error ? err.message : "Failed to skip question");
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
      setError(err instanceof Error ? err.message : "Failed to ask agent");
    } finally {
      setSubmitting(false);
    }
  }, [answer, chatId, queryClient, requestId, question]);

  if (openRequestsQuery.isLoading || !parsed) {
    return (
      <View style={[styles.sheet, styles.loading]}>
        {openRequestsQuery.isError ? (
          <Text style={styles.errorText}>Could not load the open question.</Text>
        ) : (
          <ActivityIndicator color={colors.accent} />
        )}
      </View>
    );
  }

  const options = parsed.request.options ?? [];
  const canSubmit = selected.length > 0 || answer.trim().length > 0;

  return (
    <KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.kicker}>Asked you</Text>
            <Text style={styles.subtitle}>Open question</Text>
          </View>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.headerAction}>Show earlier chat</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          bounces={false}
        >
          <MarkdownText value={typeof question?.content === "string" ? question.content : ""} />
          {options.length > 0 && (
            <View style={styles.options}>
              {options.map((option, index) => {
                const isSelected = selected.includes(index);
                return (
                  <Pressable
                    key={`${option.label}-${option.description ?? ""}`}
                    onPress={() =>
                      setSelected((current) => {
                        if (parsed.request.multiSelect === true) {
                          return isSelected ? current.filter((item) => item !== index) : [...current, index];
                        }
                        return isSelected ? current : [index];
                      })
                    }
                    style={[styles.option, isSelected && styles.optionSelected]}
                  >
                    <Text style={styles.optionLabel}>
                      {parsed.request.multiSelect === true ? `${isSelected ? "☑" : "☐"} ` : ""}
                      {option.label}
                    </Text>
                    {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          )}
          {thread.length > 0 && (
            <View style={styles.thread}>
              {thread.map((entry) => (
                <View key={entry.id} style={styles.threadEntry}>
                  <Text style={styles.threadAuthor}>
                    {entry.senderId === selfAgentId ? "You asked" : "Agent replied"}
                  </Text>
                  <MarkdownText value={typeof entry.content === "string" ? entry.content : ""} />
                </View>
              ))}
            </View>
          )}
        </ScrollView>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <LiveMarkdownInput
          style={styles.inputContainer}
          value={answer}
          onChangeText={setAnswer}
          placeholder={mode === "clarify" ? "Ask the agent for clarification…" : "Answer the ask…"}
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={4000}
          returnKeyType={mode === "clarify" ? "send" : "done"}
          submitBehavior="submit"
          onSubmitEditing={() => void (mode === "clarify" ? askAgent() : submit())}
        />

        <View style={styles.footer}>
          <Pressable
            onPress={() => setMode((current) => (current === "submit" ? "clarify" : "submit"))}
            disabled={submitting || advancing}
            style={({ pressed }) => [styles.modeButton, pressed && styles.pressed]}
          >
            <Text style={styles.modeText}>{mode === "clarify" ? "Answer instead" : "Ask agent"}</Text>
          </Pressable>
          {mode === "submit" && (
            <Pressable
              onPress={() => void skip()}
              disabled={submitting || advancing}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>Skip</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => void (mode === "clarify" ? askAgent() : submit())}
            disabled={submitting || advancing || (mode === "clarify" ? !answer.trim() : !canSubmit)}
            style={({ pressed }) => [
              styles.primaryButton,
              (submitting || advancing || (mode === "clarify" ? !answer.trim() : !canSubmit)) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {submitting || advancing ? (
              <ActivityIndicator color={colors.accentText} size="small" />
            ) : (
              <Text style={styles.primaryText}>{mode === "clarify" ? "Ask" : "Submit"}</Text>
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
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 28,
    paddingBottom: 12,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  kicker: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
  },
  headerAction: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "700",
    textAlign: "right",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 4,
  },
  options: {
    gap: 8,
    marginTop: 4,
  },
  option: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: "rgba(59,130,246,0.18)",
  },
  optionLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  optionDescription: {
    color: colors.textMuted,
    fontSize: 12,
  },
  thread: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 8,
    marginTop: 12,
    paddingTop: 10,
  },
  threadEntry: {
    gap: 2,
  },
  threadAuthor: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  inputContainer: {
    minHeight: 46,
    maxHeight: 120,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: 14,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
  },
  modeButton: {
    marginRight: "auto",
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  modeText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700",
  },
  secondaryButton: {
    borderRadius: 12,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryText: {
    color: colors.textSecondary,
    fontWeight: "700",
  },
  primaryButton: {
    minWidth: 78,
    alignItems: "center",
    borderRadius: 12,
    backgroundColor: colors.accent,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  primaryText: {
    color: colors.accentText,
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.75,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    textAlign: "center",
  },
});
