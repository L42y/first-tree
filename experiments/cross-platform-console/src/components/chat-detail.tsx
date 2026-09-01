import type { ChatDetail, Message } from "@first-tree/shared";
import { extractMentions } from "@first-tree/shared";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Avatar } from "~/components/avatar";
import { ChatMessageBubble } from "~/components/chat-message-bubble";
import { LiveMarkdownInput } from "~/components/live-markdown-input";
import { MessageCard } from "~/components/message-card";
import { ASK_MODAL_ROUTE, fetchOpenRequests, parseAskRequest } from "~/lib/ask";
import { useAuth } from "~/lib/auth-context";
import { getChat, listChatMessages, markMeChatRead, sendChatMessage } from "~/lib/chats-api";
import { colors } from "~/lib/theme";

const PAGE_SIZE = 50;

export function ChatDetailContent({
  chatId,
  showBack = true,
}: {
  chatId: string;
  /** Hidden when embedded in a two-pane layout. */
  showBack?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, memberId, agentId: selfAgentId } = useAuth();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<Message>>(null);
  const askModalRequestRef = useRef<string | null>(null);
  // Set when messages first arrive (or after sending) so the next
  // onContentSizeChange scrolls to the latest message exactly once.
  const pendingScrollRef = useRef(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  // Deterministic keyboard avoidance: lift the composer by the exact
  // keyboard height. Framework avoidance (KeyboardAvoidingView /
  // automaticallyAdjustKeyboardInsets) mis-measured or left the composer
  // behind the keyboard on iOS.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => setKeyboardHeight(e.endCoordinates.height));
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
    queryFn: ({ pageParam, signal }) => listChatMessages(chatId, { limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  useEffect(() => {
    void markMeChatRead(chatId).then(() => {
      // Read state is server-side; refresh the list badges immediately
      // instead of waiting for the next poll.
      void queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
    });
    pendingScrollRef.current = true;
  }, [chatId, queryClient]);

  const messageCount = (messagesQuery.data?.pages ?? []).reduce((total, page) => total + page.items.length, 0);
  useEffect(() => {
    if (messageCount > 0) pendingScrollRef.current = true;
  }, [messageCount]);

  // Markdown bubbles measure asynchronously, so content height keeps growing
  // after the first onContentSizeChange. Scrolling to the end a single time
  // therefore lands partway inside the newest message when that message is
  // long. Follow the bottom until the reader takes over by dragging.
  const userScrolledRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId changes when the route switches chats.
  useEffect(() => {
    userScrolledRef.current = false;
  }, [chatId]);

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

  // The viewer's own open ask, if any. Scoped server-side to this viewer and
  // independent of the loaded message window, so it is the whole answer to
  // "is there an ask here" — the dock renders from this and nothing else.
  const openRequestsQuery = useQuery({
    queryKey: ["chats", chatId, "open-requests"],
    queryFn: ({ signal }) => fetchOpenRequests(chatId, signal),
    refetchInterval: 30_000,
  });

  const openAsk = useMemo(() => {
    const serverOpen = openRequestsQuery.data ?? [];
    // One aggregate line per evaluation. The previous per-message logging also
    // ran a nested scan for each request, which is quadratic over the loaded
    // window — and the window now grows to ASK_WALK_MAX_PAGES * PAGE_SIZE.
    if (__DEV__) {
      const requestIds = messages.filter((m) => m.format === "request").map((m) => m.id);
      const resolvedIds = new Set(
        messages
          .map((m) => (m.metadata?.resolves as { request?: unknown } | undefined)?.request)
          .filter((id): id is string => typeof id === "string"),
      );
      const unresolved = requestIds.filter((id) => !resolvedIds.has(id));
      console.log(
        "[ask]",
        `status=${openRequestsQuery.isSuccess ? "ok" : openRequestsQuery.isError ? "err" : "loading"}`,
        `serverOpen=${serverOpen.length}`,
        `msgs=${messages.length}`,
        `requests=${requestIds.length}`,
        `unresolved=${unresolved.length}`,
        `firstUnresolved=${unresolved[0]?.slice(0, 8) ?? "none"}`,
      );
    }
    // Single source. /open-requests is scoped server-side to this viewer and
    // is independent of the loaded page, so there is nothing the message window
    // can add: reconstructing an ask from it produced false negatives when the
    // ask had scrolled away and false positives from a stale counter, and hid
    // the fact that this query was returning nothing at all.
    const first = serverOpen[0];
    if (!first) return null;
    const parsed = parseAskRequest(first);
    return parsed ? { message: first, parsed } : null;
  }, [openRequestsQuery.data, openRequestsQuery.isSuccess, openRequestsQuery.isError, messages]);

  const openAskId = openAsk?.message.id ?? null;
  const askModalVisible = pathname.includes("/ask/");

  const openAskModal = useCallback(
    (requestId: string) => {
      askModalRequestRef.current = requestId;
      void router.push({
        pathname: ASK_MODAL_ROUTE,
        params: { chatId, requestId },
      } as never);
    },
    [chatId, router],
  );

  useEffect(() => {
    if (!openAskId) {
      // A modal can briefly see an empty cache while advancing to the next
      // request. Keep the session ref until the modal has actually dismissed.
      if (!askModalVisible) askModalRequestRef.current = null;
      return;
    }
    if (askModalVisible) {
      // The modal owns queue transitions; keep the background screen from
      // pushing a duplicate when the shared open-request query changes.
      askModalRequestRef.current = openAskId;
      return;
    }
    if (askModalRequestRef.current !== openAskId) openAskModal(openAskId);
  }, [askModalVisible, openAskId, openAskModal]);

  const handleSend = useCallback(async () => {
    if (sending || !message.trim() || !memberId || openAsk) return;
    const text = message.trim();
    setMessage("");
    setSending(true);
    // Sending re-attaches the view to the bottom even if the reader had
    // scrolled up to look back through the thread.
    userScrolledRef.current = false;

    try {
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
  }, [message, memberId, chatId, chatQuery.data, queryClient, openAsk, sending]);
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
          <Text style={styles.errorText}>{error instanceof Error ? error.message : "Failed to load chat"}</Text>
          <Pressable onPress={() => void chatQuery.refetch()} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        renderItem={({ item }) => {
          const messageView =
            item.format === "card" ? (
              <MessageCard message={item} />
            ) : (
              <ChatMessageBubble
                message={item}
                isMe={item.senderId === memberId || item.senderId === user?.id}
                senderName={participantNames(item.senderId)}
                avatar={toBubbleAvatar(item.senderId)}
              />
            );
          return askModalVisible && item.id === openAskId ? (
            <View style={styles.hiddenModalMessage}>{messageView}</View>
          ) : (
            messageView
          );
        }}
        onStartReached={() => {
          if (messagesQuery.hasPreviousPage && !messagesQuery.isFetchingPreviousPage) {
            void messagesQuery.fetchPreviousPage();
          }
        }}
        onEndReachedThreshold={0.5}
        contentContainerStyle={styles.messages}
        onScrollBeginDrag={() => {
          // The reader taking over ends the follow-the-bottom behaviour until
          // they send something or reopen the chat.
          userScrolledRef.current = true;
          pendingScrollRef.current = false;
        }}
        onContentSizeChange={() => {
          if (!pendingScrollRef.current || userScrolledRef.current) return;
          // React Native can emit this callback repeatedly as markdown and
          // images finish measuring. Consume the request before scheduling
          // the one intentional initial/send scroll so later measurements do
          // not drag the reader back to the bottom.
          pendingScrollRef.current = false;
          requestAnimationFrame(() => {
            if (!userScrolledRef.current) listRef.current?.scrollToEnd({ animated: false });
          });
        }}
      />

      {openAsk && (
        <Pressable
          onPress={() => openAskModal(openAsk.message.id)}
          style={({ pressed }) => [styles.collapsedBar, pressed && styles.collapsedBarPressed]}
        >
          <Text style={styles.collapsedKicker}>Open question</Text>
          <Text style={styles.collapsedHint}>Tap to answer</Text>
        </Pressable>
      )}

      {!openAsk && (
        <View style={[styles.composer, keyboardHeight > 0 && { marginBottom: keyboardHeight }]}>
          <LiveMarkdownInput
            style={styles.inputContainer}
            value={message}
            onChangeText={setMessage}
            placeholder="Message…"
            multiline
            maxLength={4000}
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={() => void handleSend()}
          />
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
  hiddenModalMessage: {
    opacity: 0,
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
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 6,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  inputContainer: {
    flex: 1,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
});
