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

import {
  fetchChatRows,
  getChat,
  listChatMessages,
  markMeChatRead,
  sendChatMessage,
} from "~/lib/chats-api";
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
/** Ten pages back covers any realistic ask depth without scanning a whole chat. */
const ASK_WALK_MAX_PAGES = 10;
// Expo Go cannot host the enriched input's native views — fall back to a
// plain TextInput there; dev client / standalone get live markdown.
const IS_EXPO_GO = Constants.appOwnership === "expo";

export function ChatDetailContent({
  chatId,
  showBack = true,
  expectAsk = false,
}: {
  chatId: string;
  /** Hidden when embedded in a two-pane layout. */
  showBack?: boolean;
  /**
   * Optional hint from a caller that already has the list row in hand. Only
   * an override: when omitted the component derives the same signal itself,
   * so a call site that forgets it does not silently lose the ask.
   */
  expectAsk?: boolean;
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
  const [askMode, setAskMode] = useState<"submit" | "clarify">("submit");
  const [askSelected, setAskSelected] = useState<number[]>([]);
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
    void markMeChatRead(chatId).then(() => {
      // Read state is server-side; refresh the list badges immediately
      // instead of waiting for the next poll.
      void queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
    });
    pendingScrollRef.current = true;
  }, [chatId, queryClient]);

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

  // The server's /open-requests can return 0 when the ask's stored target
  // points at a stale membership agent. The list row still knows the truth
  // (openRequestCount>0) — keep paging older history until the ask message
  // is inside the loaded window.
  // The phone route renders this component straight from `/chat/[chatId]`
  // and has no list row to pass down, so relying on the prop alone meant the
  // history walk never ran on a phone — the exact case where the ask goes
  // missing. Derive the row count here from the query the shell already
  // keeps warm (same key, so this is a cache read, not an extra request).
  const chatRowsQuery = useQuery({
    queryKey: ["me", "chats", "list", "all"],
    queryFn: ({ signal }) => fetchChatRows("all", signal),
    staleTime: 30_000,
  });
  const rowOpenRequests =
    (chatRowsQuery.data ?? []).find((row) => row.chatId === chatId)?.openRequestCount ?? 0;
  const shouldExpectAsk = expectAsk || rowOpenRequests > 0;

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
        "status=" + (openRequestsQuery.isSuccess ? "ok" : openRequestsQuery.isError ? "err" : "loading"),
        "serverOpen=" + serverOpen.length,
        "msgs=" + messages.length,
        "requests=" + requestIds.length,
        "unresolved=" + unresolved.length,
        "firstUnresolved=" + (unresolved[0]?.slice(0, 8) ?? "none"),
      );
    }
    if (openRequestsQuery.isSuccess && serverOpen.length > 0) {
      const first = serverOpen[0];
      const parsed = parseAskRequest(first);
      if (parsed) return { message: first, parsed };
    }
    // Fallback: /open-requests is a live query scoped to the caller's own
    // human-agent id, so it legitimately returns nothing for an ask targeted
    // at a different id. Scan the loaded timeline for an unresolved request
    // as a second source. Note the row count that gates the history walk is a
    // stored counter and can outlive the ask it counted, so an empty result
    // here is a normal outcome rather than proof of a bug.
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

  // Walk older history while the row says an ask is open but none is yet
  // renderable. Keying the stop on `openAsk` rather than "any request-format
  // message is loaded" matters: an already-resolved ask sitting in the recent
  // window would otherwise halt the walk and strand the real one out of view.
  //
  // Bounded, because the trigger is not trustworthy: openRequestCount is a
  // stored counter on chat_user_state while /open-requests is a live query, and
  // the counter can be left incremented for an ask the live query already
  // considers resolved. On such a chat an unbounded walk would page through the
  // entire history on every open and still find nothing.
  const askWalkPagesRef = useRef(0);
  useEffect(() => {
    askWalkPagesRef.current = 0;
  }, [chatId]);
  useEffect(() => {
    if (
      shouldExpectAsk &&
      openAsk === null &&
      askWalkPagesRef.current < ASK_WALK_MAX_PAGES &&
      messagesQuery.hasPreviousPage &&
      !messagesQuery.isFetchingPreviousPage
    ) {
      askWalkPagesRef.current += 1;
      void messagesQuery.fetchPreviousPage();
    }
  }, [shouldExpectAsk, openAsk, messagesQuery, chatId]);

  const handleSend = useCallback(async () => {
    if (!message.trim() || !memberId) return;
    const text = message.trim();
    setMessage("");
    setSending(true);

    try {
      if (openAsk && askMode === "submit") {
        // While an open ask is pending, Send SUBMITS the answer (the reply
        // carries metadata.resolves per the server contract). Selected
        // option labels ride ahead of any typed note.
        const labels = askSelected
          .map((i) => openAsk.parsed.request.options?.[i]?.label)
          .filter(Boolean)
          .join(", ");
        const composed = [labels, text].filter(Boolean).join(" — ");
        await resolveAskRequest(chatId, openAsk.message, "answered", composed);
        await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
        await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "open-requests"] });
        setAskSelected([]);
        listRef.current?.scrollToEnd({ animated: true });
        return;
      }
      if (openAsk && askMode === "clarify") {
        // "Ask agent": a normal clarification message in the thread — the
        // ask stays open (no metadata.resolves).
        const asker = openAsk.message.senderId;
        const askerName = participantNames(asker);
        await sendChatMessage(chatId, `@${askerName} ${text}`, [asker]);
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
  }, [message, memberId, chatId, chatQuery.data, queryClient, openAsk, askMode, askSelected]);

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
        <View style={[styles.dockWrap, keyboardHeight > 0 && { marginBottom: keyboardHeight }]}>
        <RequestDock
          question={openAsk.message}
          parsed={openAsk.parsed}
          collapsed={false}
          onToggleCollapsed={() => setAskCollapsed(true)}
          onSkip={() => {
            void submitAnswer(openAsk.message, "");
            void queryClient.invalidateQueries({ queryKey: ["chats", chatId, "open-requests"] });
            setAskCollapsed(true);
          }}
          selected={askSelected}
          onToggleOption={(index) =>
            setAskSelected((prev) =>
              openAsk.parsed.request.multiSelect === true
                ? prev.includes(index)
                  ? prev.filter((i) => i !== index)
                  : [...prev, index]
                : prev.includes(index)
                  ? prev
                  : [index],
            )
          }
          askMode={askMode}
          onToggleAskMode={() => setAskMode((m) => (m === "submit" ? "clarify" : "submit"))}
        />
        </View>
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

      <View style={[styles.composer, keyboardHeight > 0 && { marginBottom: keyboardHeight }]}>
        <TextInput
          style={styles.input}
          value={message}
          onChangeText={setMessage}
          placeholder={openAsk ? (askMode === "clarify" ? "Ask the agent for clarification…" : "Answer the ask… (Send = Submit)") : "Message…"}
          multiline
          maxLength={4000}
          // While an ask is open the keyboard's own key is the submit action,
          // so answering never depends on a control the keyboard can cover.
          // Ordinary composing keeps the newline behaviour a multiline field
          // is expected to have.
          returnKeyType={openAsk ? (askMode === "clarify" ? "send" : "done") : "default"}
          submitBehavior={openAsk ? "submit" : "newline"}
          onSubmitEditing={openAsk ? () => void handleSend() : undefined}
        />
        <Pressable onPress={handleSend} disabled={sending || !message.trim()}>
          <View style={[styles.sendButton, (!message.trim() || sending) && styles.sendButtonDisabled]}>
            <Text style={styles.sendText}>{openAsk ? (askMode === "clarify" ? "Ask" : "Submit") : "Send"}</Text>
          </View>
        </Pressable>
      </View>
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
  dockWrap: {
    // RequestDock carries its own paddings; wrapper only hosts the lift.
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
