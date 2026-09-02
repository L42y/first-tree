import type { ChatDetail, ChatTokenUsage, MeChatRow, Message } from "@first-tree/shared";
import { extractMentions } from "@first-tree/shared";
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewToken,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "~/components/avatar";
import { ChatMessageBubble } from "~/components/chat-message-bubble";
import { LiveMarkdownInput, type LiveMarkdownInputHandle } from "~/components/live-markdown-input";
import { MessageCard } from "~/components/message-card";
import { ASK_MODAL_ROUTE, fetchOpenRequests, parseAskRequest } from "~/lib/ask";
import { useAuth } from "~/lib/auth-context";
import { clearChatUnreadRows, patchChatRowActivity } from "~/lib/chat-list-cache";
import {
  countUnreadMessages,
  findFirstUnreadIndex,
  findMessageIndexById,
  flattenNewestFirstMessages,
  formatNewMessages,
  getChatReadState,
  saveChatReadState,
} from "~/lib/chat-read-state";
import {
  getChat,
  getChatTokenUsage,
  listChatMessages,
  markMeChatRead,
  type PaginatedMessages,
  sendChatMessage,
} from "~/lib/chats-api";
import { loadLiquidGlass } from "~/lib/liquid-glass";
import {
  buildMentionCandidates,
  buildMentionInsert,
  composerPlaceholder,
  computeRequiresMention,
  findActiveMentionTrigger,
  findSolePeerAgentId,
  isSelfOnlySpeakerRoster,
  pickPrimaryAgent,
  rankMentionCandidates,
  shouldPrimeMentionOnFocus,
} from "~/lib/mentions";
import { colors } from "~/lib/theme";
import { formatTokenCount, processedTokenCount } from "~/lib/token-usage";

const PAGE_SIZE = 50;

type TimelineItem =
  | { kind: "message"; key: string; message: Message }
  | { kind: "divider"; key: string; count: number };

type MessagesCache = InfiniteData<PaginatedMessages, string | undefined>;

function patchFirstMessagePage(
  previous: MessagesCache | undefined,
  patchItems: (items: Message[]) => Message[],
): MessagesCache | undefined {
  if (!previous) return undefined;
  return {
    ...previous,
    pages: previous.pages.map((page, pageIndex) =>
      pageIndex === 0 ? { ...page, items: patchItems(page.items) } : page,
    ),
  };
}

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
  const { width: windowWidth } = useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  const { user, memberId, agentId: selfAgentId } = useAuth();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<TimelineItem>>(null);
  const askModalRequestRef = useRef<string | null>(null);
  const composerRef = useRef<LiveMarkdownInputHandle>(null);
  const focusPrimedRef = useRef(false);
  const autoPrimedDraftRef = useRef(false);
  // Set when messages first arrive (or after sending) so the next
  // onContentSizeChange scrolls to the latest message exactly once.
  const pendingScrollRef = useRef(false);
  const readLoadedRef = useRef(false);
  const bottomVisibleRef = useRef<string | null>(null);
  const latestKnownRef = useRef<string | null>(null);
  const serverSyncedRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialScrollAnchorRef = useRef<string | null>(null);
  const [frozenUnreadAnchorId, setFrozenUnreadAnchorId] = useState<string | null>(null);
  const [sessionHighestId, setSessionHighestId] = useState<string | null>(null);
  const [readReady, setReadReady] = useState(false);
  const [message, setMessage] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [composerFooterHeight, setComposerFooterHeight] = useState(0);
  // Deterministic keyboard avoidance: lift the composer by the exact
  // keyboard height. Framework avoidance (KeyboardAvoidingView /
  // automaticallyAdjustKeyboardInsets) mis-measured or left the composer
  // behind the keyboard on iOS.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const scrollOffsetRef = useRef(0);
  const listHeightRef = useRef(0);
  const messageLayoutsRef = useRef(new Map<string, { y: number; height: number }>());
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => setKeyboardHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const liquidGlass = useMemo(loadLiquidGlass, []);
  const showTokenUsage = windowWidth >= 1024;
  const tokenUsageQuery = useQuery<ChatTokenUsage>({
    queryKey: ["chats", chatId, "token-usage"],
    queryFn: () => getChatTokenUsage(chatId),
    enabled: showTokenUsage,
    refetchInterval: 60_000,
  });
  const processedTokens = tokenUsageQuery.data ? processedTokenCount(tokenUsageQuery.data) : 0;

  const chatQuery = useQuery<ChatDetail>({
    queryKey: ["chats", chatId],
    queryFn: () => getChat(chatId),
  });
  // Supervisor / admin views reach a chat via managed agents and have no
  // chat_membership row of their own — firing markRead for them would insert
  // a chat_user_state row the conversation-list query (inner-joined on
  // chat_membership) never reads, leaving a permanent dead row. Matches web's
  // canMarkRead gate in chat-by-id.tsx.
  const canMarkRead = chatQuery.data != null && chatQuery.data.viewerMembershipKind !== null;
  const markedReadChatIdRef = useRef<string | null>(null);

  // Newest-first pages from the server; flattened oldest→newest for display.
  // "Load older" fetches previous pages via the cursor.
  const messagesQuery = useInfiniteQuery({
    queryKey: ["chats", chatId, "messages"],
    queryFn: ({ pageParam, signal }) => listChatMessages(chatId, { limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const flushReadState = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!readLoadedRef.current) return;
    const bottomVisible = bottomVisibleRef.current;
    const latestKnown = latestKnownRef.current;
    if (!bottomVisible || !latestKnown) return;
    void saveChatReadState(chatId, bottomVisible, latestKnown);
  }, [chatId]);

  const scheduleReadStateSave = useCallback(() => {
    if (!readLoadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushReadState, 600);
  }, [flushReadState]);

  // Load the previous pair before the first scroll and before the server read
  // timestamp advances. The divider stays frozen at the snapshot; it never
  // slides forward as later messages arrive during this visit.
  useEffect(() => {
    let active = true;
    readLoadedRef.current = false;
    bottomVisibleRef.current = null;
    latestKnownRef.current = null;
    serverSyncedRef.current = null;
    setFrozenUnreadAnchorId(null);
    setSessionHighestId(null);
    setReadReady(false);
    initialScrollAnchorRef.current = null;
    pendingScrollRef.current = true;

    void getChatReadState(chatId).then((previousState) => {
      if (!active) return;
      initialScrollAnchorRef.current = previousState?.bottomVisibleMessageId ?? null;
      setFrozenUnreadAnchorId(previousState?.latestKnownMessageId ?? null);
      readLoadedRef.current = true;
      setReadReady(true);
    });

    return () => {
      active = false;
      flushReadState();
    };
  }, [chatId, flushReadState]);

  // Mark read once membership is confirmed and the local read-state has
  // loaded. Deduped per chatId like web's markedChatIdRef so a refetch of
  // chatQuery does not re-fire the POST.
  useEffect(() => {
    if (!readReady || !canMarkRead) return;
    if (markedReadChatIdRef.current === chatId) return;
    markedReadChatIdRef.current = chatId;
    // Clear the cached badge immediately so returning to Chats does not
    // flash the old unread state while the authoritative refresh is in flight.
    queryClient.setQueriesData<MeChatRow[]>({ queryKey: ["me", "chats", "list"] }, (previous) =>
      clearChatUnreadRows(previous, chatId),
    );
    void markMeChatRead(chatId).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
    });
  }, [chatId, canMarkRead, readReady, queryClient]);

  const messageCount = (messagesQuery.data?.pages ?? []).reduce((total, page) => total + page.items.length, 0);
  useEffect(() => {
    if (messageCount > 0) pendingScrollRef.current = true;
  }, [messageCount]);

  const messages = useMemo(
    () => flattenNewestFirstMessages((messagesQuery.data?.pages ?? []).map((page) => page.items)),
    [messagesQuery.data],
  );
  const latestMessage = messages.at(-1);
  const latestServerMessageId = latestMessage && !latestMessage.id.startsWith("optimistic-") ? latestMessage.id : null;

  useEffect(() => {
    latestKnownRef.current = latestServerMessageId;
    if (!readReady || !canMarkRead) return;
    if (!latestServerMessageId) return;
    if (serverSyncedRef.current === latestServerMessageId) return;
    serverSyncedRef.current = latestServerMessageId;

    // The chat can receive a message while it is open. Mark that arrival read
    // immediately and clear cached list badges; visibility of the unread pill
    // is driven by the local scroll watermark until the user reaches it.
    queryClient.setQueriesData<MeChatRow[]>({ queryKey: ["me", "chats", "list"] }, (previous) =>
      clearChatUnreadRows(previous, chatId),
    );
    void markMeChatRead(chatId).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
    });
  }, [chatId, latestServerMessageId, queryClient, readReady, canMarkRead]);

  const selfSenderIds = useMemo(
    () => [memberId, user?.id].filter((id): id is string => Boolean(id)),
    [memberId, user?.id],
  );
  const unreadBaselineId = useMemo(() => {
    const frozenIndex = findMessageIndexById(messages, frozenUnreadAnchorId);
    const sessionIndex = findMessageIndexById(messages, sessionHighestId);
    if (frozenIndex < 0) return sessionHighestId;
    if (sessionIndex < 0) return frozenUnreadAnchorId;
    return sessionIndex > frozenIndex ? sessionHighestId : frozenUnreadAnchorId;
  }, [frozenUnreadAnchorId, messages, sessionHighestId]);
  const unreadCount = useMemo(
    () => countUnreadMessages(messages, unreadBaselineId, selfSenderIds),
    [messages, selfSenderIds, unreadBaselineId],
  );
  const unreadLabel = formatNewMessages(unreadCount);
  const dividerInsertIndex = useMemo(() => {
    const firstUnreadIndex = findFirstUnreadIndex(messages, frozenUnreadAnchorId, selfSenderIds);
    if (firstUnreadIndex < 0) return -1;
    const reachedIndex = findMessageIndexById(messages, unreadBaselineId);
    // Once the viewer's bottom watermark reaches the first unread row, stop
    // rendering the divider instead of leaving a stale ribbon mid-thread.
    if (reachedIndex >= firstUnreadIndex) return -1;
    return firstUnreadIndex;
  }, [frozenUnreadAnchorId, messages, selfSenderIds, unreadBaselineId]);
  const timeline = useMemo<TimelineItem[]>(() => {
    const messageItems = messages.map((message): TimelineItem => ({ kind: "message", key: message.id, message }));
    if (dividerInsertIndex < 0) return messageItems;
    const divider: TimelineItem = { kind: "divider", key: "unread-divider", count: unreadCount };
    return [...messageItems.slice(0, dividerInsertIndex), divider, ...messageItems.slice(dividerInsertIndex)];
  }, [dividerInsertIndex, messages, unreadCount]);

  // Markdown bubbles measure asynchronously, so content height keeps growing
  // after the first onContentSizeChange. Scrolling to the end a single time
  // therefore lands partway inside the newest message when that message is
  // long. Follow the bottom until the reader takes over by dragging.
  const userScrolledRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId changes when the route switches chats.
  useEffect(() => {
    userScrolledRef.current = false;
    focusPrimedRef.current = false;
    autoPrimedDraftRef.current = false;
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
  // The glass composer overlays the final messages. Read-state stays based on
  // the area actually exposed above it, not the full FlatList viewport.
  const composerReserve = openAsk ? 0 : composerFooterHeight + keyboardHeight;
  const ComposerSurface = liquidGlass?.GlassView;

  // Speaker-only chat roster. Routing uses immutable canonical names; the
  // display label is only for the picker row.
  const mentionCandidates = useMemo(
    () => buildMentionCandidates(chatQuery.data?.participants ?? [], selfAgentId),
    [chatQuery.data?.participants, selfAgentId],
  );
  const participantAgentIds = useMemo(
    () => (chatQuery.data?.participants ?? []).map((participant) => participant.agentId),
    [chatQuery.data?.participants],
  );
  const requiresMention = useMemo(
    () => computeRequiresMention(participantAgentIds, selfAgentId),
    [participantAgentIds, selfAgentId],
  );
  const selfOnlyRoster = useMemo(
    () => isSelfOnlySpeakerRoster(participantAgentIds, selfAgentId),
    [participantAgentIds, selfAgentId],
  );
  const primaryAgentId = useMemo(
    () => pickPrimaryAgent(chatQuery.data?.participants ?? [], selfAgentId),
    [chatQuery.data?.participants, selfAgentId],
  );
  const inputPlaceholder = useMemo(() => {
    // Until the roster loads there is no resolved peer to name.
    if (!chatQuery.data) return "Message…";
    const primary = chatQuery.data.participants.find((participant) => participant.agentId === primaryAgentId);
    return composerPlaceholder({
      selfOnlyRoster,
      requiresMention,
      primaryDisplayName: primary?.displayName ?? null,
    });
  }, [chatQuery.data, primaryAgentId, requiresMention, selfOnlyRoster]);
  const solePeerAgentId = useMemo(
    () => findSolePeerAgentId(chatQuery.data?.participants ?? [], selfAgentId),
    [chatQuery.data?.participants, selfAgentId],
  );
  const draftMentions = useMemo(() => extractMentions(message, mentionCandidates), [message, mentionCandidates]);
  const effectiveSendMentions = useMemo(
    () => (solePeerAgentId ? [...new Set([...draftMentions, solePeerAgentId])] : draftMentions),
    [draftMentions, solePeerAgentId],
  );
  const sendBlockedByMentionGate = requiresMention && draftMentions.length === 0;
  const activeMentionTrigger = useMemo(() => findActiveMentionTrigger(message, caret), [message, caret]);
  const visibleMentionCandidates = useMemo(
    () => (activeMentionTrigger ? rankMentionCandidates(mentionCandidates, activeMentionTrigger.query) : []),
    [activeMentionTrigger, mentionCandidates],
  );

  const applyMentionPick = useCallback(
    (candidate: (typeof mentionCandidates)[number]) => {
      if (!activeMentionTrigger) return;
      const insertion = buildMentionInsert(message, activeMentionTrigger, candidate);
      setMessage(insertion.text);
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.setSelection(insertion.cursor, insertion.cursor);
      });
    },
    [activeMentionTrigger, message],
  );

  const handleComposerFocus = useCallback(() => {
    if (
      !shouldPrimeMentionOnFocus({
        requiresMention,
        dockActive: openAsk != null,
        alreadyPrimed: focusPrimedRef.current,
        draftLength: message.length,
        mentionCandidateCount: mentionCandidates.length,
      })
    ) {
      return;
    }
    focusPrimedRef.current = true;
    autoPrimedDraftRef.current = true;
    setMessage("@");
    setCaret(1);
    requestAnimationFrame(() => {
      composerRef.current?.setSelection(1, 1);
    });
  }, [message.length, mentionCandidates.length, openAsk, requiresMention]);

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

  // The dock can arrive after the composer is focused. A question owns
  // addressing at that point, so remove the untouched auto-prime token.
  useEffect(() => {
    if (!openAsk || message !== "@" || !autoPrimedDraftRef.current) return;
    focusPrimedRef.current = false;
    autoPrimedDraftRef.current = false;
    setMessage("");
    setCaret(0);
    requestAnimationFrame(() => {
      composerRef.current?.setSelection(0, 0);
    });
  }, [message, openAsk]);

  const handleSend = useCallback(async () => {
    if (sending || !message.trim() || !memberId || openAsk || sendBlockedByMentionGate) return;
    const text = message.trim();
    // Structured IDs—not visible display names—are the wire contract. The
    // sole-peer default has already been folded into this list.
    const mentions = effectiveSendMentions;
    const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticAt = new Date().toISOString();
    const optimisticMessage: Message = {
      id: optimisticId,
      chatId,
      senderId: memberId,
      senderKind: "member",
      senderProvider: null,
      format: "text",
      content: text,
      metadata: mentions.length > 0 ? { mentions } : {},
      inReplyTo: null,
      source: "web",
      createdAt: optimisticAt,
    };
    const messagesQueryKey = ["chats", chatId, "messages"];
    queryClient.setQueryData<MessagesCache>(messagesQueryKey, (previous) =>
      patchFirstMessagePage(previous, (items) => [optimisticMessage, ...items]),
    );
    // The list row is a projection of the server-side chat. Mirror the same
    // fields optimistically so returning to Chats never shows stale content.
    queryClient.setQueriesData<MeChatRow[]>({ queryKey: ["me", "chats", "list"] }, (previous) =>
      patchChatRowActivity(previous, chatId, text, optimisticAt),
    );
    setMessage("");
    setCaret(0);
    setSending(true);
    setSendError(null);
    // Sending re-attaches the view to the bottom even if the reader had
    // scrolled up to look back through the thread.
    userScrolledRef.current = false;

    try {
      const saved = await sendChatMessage(chatId, text, mentions);
      queryClient.setQueryData<MessagesCache>(messagesQueryKey, (previous) =>
        patchFirstMessagePage(previous, (items) => items.map((item) => (item.id === optimisticId ? saved : item))),
      );
      queryClient.setQueriesData<MeChatRow[]>({ queryKey: ["me", "chats", "list"] }, (previous) =>
        patchChatRowActivity(previous, chatId, text, saved.createdAt),
      );
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
      await queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
      bottomVisibleRef.current = saved.id;
      latestKnownRef.current = saved.id;
      serverSyncedRef.current = saved.id;
      setSessionHighestId(saved.id);
      void saveChatReadState(chatId, saved.id, saved.id);
      pendingScrollRef.current = true;
      listRef.current?.scrollToEnd({ animated: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      // Re-show the message so the user can retry.
      setMessage(text);
      setSendError(msg);
      queryClient.setQueryData<MessagesCache>(messagesQueryKey, (previous) =>
        patchFirstMessagePage(previous, (items) => items.filter((item) => item.id !== optimisticId)),
      );
      void queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
      // eslint-disable-next-line no-console
      console.error("Send failed:", msg);
    } finally {
      setSending(false);
    }
  }, [effectiveSendMentions, message, memberId, openAsk, queryClient, sendBlockedByMentionGate, sending, chatId]);
  const isLoading = chatQuery.isLoading || messagesQuery.isLoading;
  const error = chatQuery.error ?? messagesQuery.error;
  const scrollToInitialAnchor = useCallback(() => {
    const anchorId = initialScrollAnchorRef.current;
    if (!anchorId) {
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }
    const anchorIndex = findMessageIndexById(messages, anchorId);
    // A snapshot can age out of the newest 50 messages. Fall back to the tip
    // instead of scrolling to an unrelated row at the top of the window.
    if (anchorIndex < 0) {
      initialScrollAnchorRef.current = null;
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }
    listRef.current?.scrollToIndex({ animated: false, index: anchorIndex, viewPosition: 1 });
  }, [messages]);

  // AsyncStorage and the first network page resolve independently. Do not
  // perform the one-shot scroll until the read pair has resolved; otherwise a
  // fast first paint sends the viewer to the tip before the unread anchor is
  // known.
  useEffect(() => {
    if (!readReady || messages.length === 0 || !pendingScrollRef.current || userScrolledRef.current) return;
    pendingScrollRef.current = false;
    requestAnimationFrame(() => scrollToInitialAnchor());
  }, [messages.length, readReady, scrollToInitialAnchor]);

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const exposedBottom = scrollOffsetRef.current + listHeightRef.current - composerReserve;
      const isExposed = (token: ViewToken) => {
        if (!token.isViewable) return false;
        const layout = messageLayoutsRef.current.get(token.key);
        if (!layout) return true;
        const exposedHeight = Math.max(0, Math.min(layout.height, exposedBottom - layout.y));
        return exposedHeight / layout.height >= 0.98;
      };
      const bottom = viewableItems.filter(isExposed).reduce<(typeof viewableItems)[number] | null>((latest, token) => {
        if (!latest || (token.index ?? -1) > (latest.index ?? -1)) return token;
        return latest;
      }, null);
      const messageId =
        bottom?.item && typeof bottom.item === "object" && "id" in bottom.item
          ? String((bottom.item as { id: unknown }).id)
          : null;
      if (!messageId) return;
      bottomVisibleRef.current = messageId;

      const currentIndex = findMessageIndexById(messages, messageId);
      setSessionHighestId((previous) => {
        const previousIndex = findMessageIndexById(messages, previous);
        if (currentIndex >= 0 && (previousIndex < 0 || currentIndex > previousIndex)) return messageId;
        return previous;
      });
      scheduleReadStateSave();
    },
    [composerReserve, messages, scheduleReadStateSave],
  );

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
        style={styles.timeline}
        data={timeline}
        keyExtractor={(item) => item.key}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        renderItem={({ item }) => {
          if (item.kind === "divider") {
            return (
              <View style={styles.unreadDivider}>
                <View style={styles.unreadDividerLine} />
                <Text style={styles.unreadDividerText}>New messages</Text>
                <View style={styles.unreadDividerLine} />
              </View>
            );
          }
          const { message: itemMessage } = item;
          const messageView =
            itemMessage.format === "card" ? (
              <MessageCard message={itemMessage} />
            ) : (
              <ChatMessageBubble
                message={itemMessage}
                isMe={itemMessage.senderId === memberId || itemMessage.senderId === user?.id}
                senderName={participantNames(itemMessage.senderId)}
                avatar={toBubbleAvatar(itemMessage.senderId)}
              />
            );
          return askModalVisible && itemMessage.id === openAskId ? (
            <View style={styles.hiddenModalMessage}>{messageView}</View>
          ) : (
            <View
              onLayout={({ nativeEvent: { layout } }) => {
                messageLayoutsRef.current.set(item.key, { y: layout.y, height: layout.height });
              }}
            >
              {messageView}
            </View>
          );
        }}
        onStartReached={() => {
          if (messagesQuery.hasPreviousPage && !messagesQuery.isFetchingPreviousPage) {
            void messagesQuery.fetchPreviousPage();
          }
        }}
        onEndReachedThreshold={0.5}
        contentContainerStyle={[styles.messages, { paddingBottom: Math.max(8, composerReserve + 12) }]}
        scrollEventThrottle={16}
        onScroll={({ nativeEvent: { contentOffset } }) => {
          scrollOffsetRef.current = contentOffset.y;
        }}
        onLayout={({ nativeEvent: { layout } }) => {
          listHeightRef.current = layout.height;
        }}
        onScrollBeginDrag={() => {
          // The reader taking over ends the follow-the-bottom behaviour until
          // they send something or reopen the chat.
          userScrolledRef.current = true;
          pendingScrollRef.current = false;
        }}
        onViewableItemsChanged={handleViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 98 }}
        onScrollToIndexFailed={(info) => {
          // Markdown/card bubbles have dynamic heights, so FlatList's own
          // length estimate for an unmeasured, off-screen anchor is wrong on
          // the first attempt. Retry once layout has caught up instead of
          // leaving the reader wherever that first bad estimate landed.
          setTimeout(() => {
            listRef.current?.scrollToIndex({ animated: false, index: info.index, viewPosition: 1 });
          }, 50);
        }}
        onContentSizeChange={() => {
          if (!readReady || !pendingScrollRef.current || userScrolledRef.current) return;
          // React Native can emit this callback repeatedly as markdown and
          // images finish measuring. Consume the request before scheduling
          // the one intentional initial/send scroll so later measurements do
          // not drag the reader back to the bottom.
          pendingScrollRef.current = false;
          requestAnimationFrame(() => {
            if (!userScrolledRef.current) scrollToInitialAnchor();
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
        <View
          style={[
            styles.composerFooter,
            {
              bottom: keyboardHeight,
              paddingBottom: keyboardHeight > 0 ? 0 : safeAreaInsets.bottom,
            },
          ]}
          onLayout={({ nativeEvent: { layout } }) => {
            setComposerFooterHeight((previous) =>
              Math.abs(previous - layout.height) < 0.5 ? previous : layout.height,
            );
          }}
        >
          {sendError && (
            <View style={styles.composerNotice}>
              <Text style={styles.sendError} numberOfLines={2}>
                Couldn't send: {sendError}
              </Text>
            </View>
          )}
          {activeMentionTrigger && visibleMentionCandidates.length > 0 && (
            <View style={styles.mentionPicker}>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={styles.mentionList}
                contentContainerStyle={styles.mentionListContent}
              >
                {visibleMentionCandidates.map((candidate) => (
                  <Pressable
                    key={candidate.agentId}
                    onPress={() => applyMentionPick(candidate)}
                    style={({ pressed }) => [styles.mentionRow, pressed && styles.mentionRowPressed]}
                  >
                    <Avatar name={candidate.displayName} seed={candidate.agentId} size={24} kind="agent" />
                    <View style={styles.mentionLabels}>
                      <Text style={styles.mentionDisplayName} numberOfLines={1}>
                        {candidate.displayName}
                      </Text>
                      <Text style={styles.mentionName} numberOfLines={1}>
                        @{candidate.name}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}
          {ComposerSurface ? (
            <ComposerSurface
              style={styles.glassComposerCard}
              glassEffectStyle="regular"
              colorScheme="dark"
              isInteractive
            >
              {showTokenUsage && processedTokens > 0 && (
                <Text style={styles.tokenUsage}>{formatTokenCount(processedTokens)} processed tokens in this chat</Text>
              )}
              <View style={styles.composer}>
                <LiveMarkdownInput
                  ref={composerRef}
                  style={styles.glassInputContainer}
                  value={message}
                  onChangeText={setMessage}
                  onSelectionChange={({ nativeEvent: { selection } }) => setCaret(selection.start)}
                  onFocus={handleComposerFocus}
                  placeholder={inputPlaceholder}
                  multiline
                  maxLength={4000}
                  returnKeyType="send"
                  submitBehavior="submit"
                  onSubmitEditing={() => {
                    const first = visibleMentionCandidates[0];
                    if (activeMentionTrigger && first) applyMentionPick(first);
                    else void handleSend();
                  }}
                />
              </View>
            </ComposerSurface>
          ) : (
            <View style={styles.composerCard}>
              {showTokenUsage && processedTokens > 0 && (
                <Text style={styles.tokenUsage}>{formatTokenCount(processedTokens)} processed tokens in this chat</Text>
              )}
              <View style={styles.composer}>
                <LiveMarkdownInput
                  ref={composerRef}
                  style={styles.inputContainer}
                  value={message}
                  onChangeText={setMessage}
                  onSelectionChange={({ nativeEvent: { selection } }) => setCaret(selection.start)}
                  onFocus={handleComposerFocus}
                  placeholder={inputPlaceholder}
                  multiline
                  maxLength={4000}
                  returnKeyType="send"
                  submitBehavior="submit"
                  onSubmitEditing={() => {
                    const first = visibleMentionCandidates[0];
                    if (activeMentionTrigger && first) applyMentionPick(first);
                    else void handleSend();
                  }}
                />
              </View>
            </View>
          )}
        </View>
      )}

      {unreadLabel && (
        <Pressable
          onPress={() => {
            userScrolledRef.current = false;
            pendingScrollRef.current = true;
            listRef.current?.scrollToEnd({ animated: true });
          }}
          style={[styles.unreadPill, { bottom: (openAsk ? 72 : composerReserve) + 12 }]}
        >
          <Text style={styles.unreadPillText}>↓ {unreadLabel}</Text>
        </Pressable>
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
  timeline: {
    flex: 1,
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
  composerFooter: {
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    paddingHorizontal: 8,
  },
  composerNotice: {
    marginBottom: 6,
    borderRadius: 14,
    backgroundColor: colors.surfaceStrong,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  unreadDivider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: 12,
  },
  unreadDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  unreadDividerText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  unreadPill: {
    position: "absolute",
    right: 16,
    bottom: 76,
    borderRadius: 18,
    backgroundColor: colors.surfaceStrong,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 7,
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  unreadPillText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
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
  composerCard: {
    overflow: "hidden",
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingTop: 4,
    paddingBottom: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  glassComposerCard: {
    overflow: "hidden",
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: "transparent",
    paddingTop: 4,
    paddingBottom: 4,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 6,
    gap: 8,
  },
  tokenUsage: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 2,
    color: colors.textMuted,
    fontSize: 11,
  },
  sendError: {
    paddingHorizontal: 16,
    color: colors.danger,
    fontSize: 12,
  },
  mentionPicker: {
    marginHorizontal: 8,
    marginBottom: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
    overflow: "hidden",
  },
  mentionList: {
    maxHeight: 168,
  },
  mentionListContent: {
    paddingVertical: 4,
  },
  mentionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  mentionRowPressed: {
    backgroundColor: colors.surface,
  },
  mentionLabels: {
    flex: 1,
    gap: 1,
  },
  mentionDisplayName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  mentionName: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  inputContainer: {
    flex: 1,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  glassInputContainer: {
    flex: 1,
    borderRadius: 20,
    backgroundColor: "transparent",
  },
});
