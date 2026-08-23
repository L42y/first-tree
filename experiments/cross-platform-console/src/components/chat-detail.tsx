import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { extractMentions } from "@first-tree/shared";
import type { ChatDetail, Message } from "@first-tree/shared";

import Constants from "expo-constants";
import { EnrichedMarkdownTextInput } from "react-native-enriched-markdown";

import { getChat, listChatMessages, markMeChatRead, sendChatMessage } from "~/lib/chats-api";
import { useAuth } from "~/lib/auth-context";
import { ChatMessageBubble } from "~/components/chat-message-bubble";
import { RequestCard } from "~/components/request-card";
import { RequestDock } from "~/components/request-dock";
import {
  askAgentForClarification,
  fetchOpenRequests,
  parseAskRequest,
  resolveAskRequest,
} from "~/lib/ask";
import { MessageCard } from "~/components/message-card";
import { MarkdownText } from "~/components/markdown-text";
import { Avatar } from "~/components/avatar";
import { colors } from "~/lib/theme";
import type { PaginatedMessages } from "~/lib/chats-api";

const PAGE_SIZE = 50;
// Expo Go cannot host the enriched input's native views — fall back to a
// plain TextInput there; dev client / standalone get live markdown.
const IS_EXPO_GO = Constants.appOwnership === "expo";

export function ChatDetailContent({
  chatId,
  showBack = true,
}: {
  chatId: string;
  /** Hide the back affordance when embedded in a two-pane wide layout. */
  showBack?: boolean;
}) {
  const router = useRouter();
  const { user, memberId, agentId: selfAgentId } = useAuth();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<Message>>(null);
  // Set when messages first arrive (or after sending) so the next
  // onContentSizeChange scrolls to the latest message exactly once,
  // instead of fighting the user's scroll position forever.
  const pendingScrollRef = useRef(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  // Deterministic keyboard avoidance: lift the composer by the exact
  // keyboard height. Framework avoidance (KeyboardAvoidingView /
  // automaticallyAdjustKeyboardInsets) mis-measured or left the composer
  // behind the keyboard on iOS.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [askCollapsed, setAskCollapsed] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const showSub = Keyboard.addListener("keyboardDidShow", (e) =>
      setKeyboardHeight(e.endCoordinates.height),
    );
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const chatQuery = useQuery<ChatDetail>({
    queryKey: ["chats", chatId],
    queryFn: () => getChat(chatId),
  });

  // Newest-first pages from the server; flattened oldest→newest for display.
  // "Load older" fetches previous pages via the cursor.
  const messagesQuery = useInfiniteQuery({
    queryKey: ["chats", chatId, "messages"],
    queryFn: ({ pageParam, signal }) =>
      listChatMessages(chatId, { limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  useEffect(() => {
    void markMeChatRead(chatId);
    pendingScrollRef.current = true;
  }, [chatId]);

  const messageCount = (messagesQuery.data?.pages ?? []).reduce(
    (total, page) => total + page.items.length,
    0,
  );
  useEffect(() => {
    if (messageCount > 0) pendingScrollRef.current = true;
  }, [messageCount]);

  const findParticipant = useCallback(
    (senderId: string) => chatQuery.data?.participants.find((p) => p.agentId === senderId),
    [chatQuery.data],
  );

  const participantNames = useCallback(
    (senderId: string) => findParticipant(senderId)?.displayName ?? senderId.slice(0, 8),
    [findParticipant],
  );

  const toBubbleAvatar = useCallback(
    (senderId: string) => {
      const p = findParticipant(senderId);
      if (!p) return undefined;
      return {
        name: p.displayName,
        seed: p.agentId,
        colorToken: p.avatarColorToken ?? null,
        imageUrl: p.avatarImageUrl ?? null,
        kind: p.type === "human" ? ("human" as const) : ("agent" as const),
      };
    },
    [findParticipant],
  );

  const chat = chatQuery.data;
  const messages = useMemo(
    () =>
      (messagesQuery.data?.pages ?? [])
        .flatMap((page) => page.items)
        .slice()
        .reverse(),
    [messagesQuery.data],
  );

  // The viewer's own open ask (if any): targeted at selfAgentId and not yet
  // resolved by any later message. Docked above the list; the composer
  // doubles as its free-text answer path.
  // Server-authoritative: open asks scoped to THIS viewer, independent of
  // the loaded message window (an ask outside the latest-50 page used to
  // vanish). Falls back to a timeline-scan only if the endpoint errors.
  const openRequestsQuery = useQuery({
    queryKey: ["chats", chatId, "open-requests"],
    queryFn: ({ signal }) => fetchOpenRequests(chatId, signal),
    refetchInterval: 30_000,
  });

  const openAsk = useMemo(() => {
    const serverOpen = openRequestsQuery.data ?? [];
    if (__DEV__) {
      console.log(
        "[ask]",
        "status=" + (openRequestsQuery.isSuccess ? "ok" : openRequestsQuery.isError ? "err" : "loading"),
        "serverOpen=" + serverOpen.length,
        "msgs=" + messages.length,
      );
    }
    if (openRequestsQuery.isSuccess && serverOpen.length > 0) {
      const first = serverOpen[0];
      const parsed = parseAskRequest(first);
      if (parsed) return { message: first, parsed };
    }
    // Fallback + union: the server scopes open-requests by the caller's
    // CURRENT human agent — an ask created under a different membership can
    // return empty there while still being open in this chat. Scan the
    // loaded timeline for unresolved request-format messages.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.format !== "request") continue;
      const parsed = parseAskRequest(msg);
      if (!parsed) continue;
      const resolved = messages.some((m) => {
        const resolves = m.metadata?.resolves as { request?: unknown } | undefined;
        return typeof resolves?.request === "string" && resolves.request === msg.id;
      });
      if (!resolved) return { message: msg, parsed };
    }
    return null;
  }, [openRequestsQuery.data, openRequestsQuery.isSuccess, messages]);

  const handleSend = useCallback(async () => {
    if (!message.trim() || !memberId) return;
    const text = message.trim();
    setMessage("");
    setSending(true);

    try {
      if (openAsk && askCollapsed) {
        // While an open ask is pending, Send answers it (the reply carries
        // metadata.resolves per the server contract).
        await resolveAskRequest(chatId, openAsk.message, "answered", text);
        await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
        listRef.current?.scrollToEnd({ animated: true });
        return;
      }

      const mentions = extractMentions(
        text,
        chatQuery.data?.participants.map((p) => ({ agentId: p.agentId, name: p.displayName })) ?? [],
      );

      await sendChatMessage(chatId, text, mentions);
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
      await queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
      listRef.current?.scrollToEnd({ animated: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      // Re-show the message so the user can retry.
      setMessage(text);
      // eslint-disable-next-line no-console
      console.error("Send failed:", msg);
    } finally {
      setSending(false);
    }
  }, [message, memberId, chatId, chatQuery.data, queryClient, openAsk]);

  const submitAnswer = useCallback(
    async (question: Message, answer: string) => {
      try {
        await resolveAskRequest(chatId, question, answer ? "answered" : "closed", answer);
        await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
      } catch {
        // Resolution failures surface via the next poll refetch.
      }
    },
    [chatId, queryClient],
  );


  const isLoading = chatQuery.isLoading || messagesQuery.isLoading;
  const error = chatQuery.error ?? messagesQuery.error;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        {showBack && (
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        )}
        <Avatar
          name={chat?.participants.find((p) => p.agentId !== selfAgentId)?.displayName ?? chat?.title ?? chatId}
          seed={chat?.participants.find((p) => p.agentId !== selfAgentId)?.agentId ?? chatId}
          colorToken={chat?.participants.find((p) => p.agentId !== selfAgentId)?.avatarColorToken ?? null}
          imageUrl={chat?.participants.find((p) => p.agentId !== selfAgentId)?.avatarImageUrl ?? null}
          kind={chat?.participants.find((p) => p.agentId !== selfAgentId)?.type === "human" ? "human" : "agent"}
          size={32}
        />
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {chat?.title ?? chatId.slice(0, 8)}
          </Text>
          {chat?.participants && (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {chat.participants.map((p) => p.displayName).join(", ")}
            </Text>
          )}
        </View>
      </View>

      {isLoading && (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      )}

      {error && !isLoading && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            {error instanceof Error ? error.message : "Failed to load chat"}
          </Text>
          <Pressable onPress={() => void chatQuery.refetch()} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        renderItem={({ item }) => {
          return item.format === "request" ? (
            <RequestCard
              chatId={chatId}
              message={item}
              messages={messages}
              selfAgentId={selfAgentId}
            />
          ) : item.format === "card" ? (
            <MessageCard message={item} />
          ) : (
            <ChatMessageBubble
              message={item}
              isMe={item.senderId === memberId || item.senderId === user?.id}
              senderName={participantNames(item.senderId)}
              avatar={toBubbleAvatar(item.senderId)}
            />
          );
        }}
        onStartReached={() => {
          if (messagesQuery.hasPreviousPage && !messagesQuery.isFetchingPreviousPage) {
            void messagesQuery.fetchPreviousPage();
          }
        }}
        onEndReachedThreshold={0.5}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => {
          if (!pendingScrollRef.current) return;
          pendingScrollRef.current = false;
          requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
        }}
      />

      {openAsk && !askCollapsed && (
        <RequestDock
          question={openAsk.message}
          parsed={openAsk.parsed}
          collapsed={false}
          onToggleCollapsed={() => setAskCollapsed(true)}
          onSubmit={(answer) => {
            void submitAnswer(openAsk.message, answer);
            void queryClient.invalidateQueries({ queryKey: ["chats", chatId, "open-requests"] });
            setAskCollapsed(true);
          }}
          onSkip={() => {
            void submitAnswer(openAsk.message, "");
            void queryClient.invalidateQueries({ queryKey: ["chats", chatId, "open-requests"] });
            setAskCollapsed(true);
          }}
          onAskAgent={(text) => {
            void (async () => {
              await askAgentForClarification(chatId, openAsk.message.id, text);
              await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
              await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "open-requests"] });
            })();
          }}
        />
      )}

      {openAsk && askCollapsed && (
        <Pressable
          onPress={() => setAskCollapsed(false)}
          style={({ pressed }) => [styles.collapsedBar, pressed && styles.collapsedBarPressed]}
        >
          <Text style={styles.collapsedKicker}>Open question</Text>
          <Text style={styles.collapsedHint}>Tap to answer</Text>
        </Pressable>
      )}

      {(!openAsk || askCollapsed) && (
      <View style={[styles.composer, keyboardHeight > 0 && { marginBottom: keyboardHeight }]}>
        <TextInput
          style={styles.input}
          value={message}
          onChangeText={setMessage}
          placeholder="Message…"
          multiline
          maxLength={4000}
        />
        <Pressable onPress={handleSend} disabled={sending || !message.trim()}>
          <View style={[styles.sendButton, (!message.trim() || sending) && styles.sendButtonDisabled]}>
            <Text style={styles.sendText}>Send</Text>
          </View>
        </Pressable>
      </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  preview: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 48,
    paddingBottom: 12,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  backButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  backText: {
    fontSize: 14,
    color: colors.text,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: colors.text,
  },
  headerSubtitle: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  messages: {
    paddingVertical: 8,
  },
  errorBox: {
    padding: 16,
    gap: 8,
    alignItems: "center",
  },
  errorText: {
    color: colors.danger,
    textAlign: "center",
  },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.accent,
  },
  retryText: {
    color: colors.accentText,
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
  collapsedBarPressed: {
    opacity: 0.75,
  },
  collapsedKicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.accent,
  },
  collapsedHint: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  sendButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: colors.accent,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendText: {
    color: colors.accentText,
    fontWeight: "bold",
  },
});
