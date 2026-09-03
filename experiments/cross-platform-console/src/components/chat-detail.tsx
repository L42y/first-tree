import Ionicons from "@expo/vector-icons/Ionicons";
import type { ChatDetail, ChatTokenUsage, MeChatRow, Message } from "@first-tree/shared";
import { extractMentions } from "@first-tree/shared";
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  type LayoutChangeEvent,
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
import { AddParticipantConfirm } from "~/components/add-participant-confirm";
import { AgentMetaLine } from "~/components/agent-meta";
import { AskThread } from "~/components/ask-thread";
import { Avatar } from "~/components/avatar";
import { ChatDetailsSheet } from "~/components/chat-details-sheet";
import { ChatMessageBubble } from "~/components/chat-message-bubble";
import { ChatParticipantsSheet } from "~/components/chat-participants";
import { ComposerField } from "~/components/composer-field";
import type { LiveMarkdownInputHandle } from "~/components/live-markdown-input";
import { MessageCard } from "~/components/message-card";
import { RenameChatModal } from "~/components/rename-chat-modal";
import { ASK_MODAL_ROUTE, collectRequestIds, fetchOpenRequests, parseAskRequest, threadDescendantIds } from "~/lib/ask";
import { useAuth } from "~/lib/auth-context";
import { clearChatUnreadRows, patchChatRowActivity } from "~/lib/chat-list-cache";
import {
  countUnreadMessages,
  findFirstUnreadIndex,
  findMessageIndexById,
  flattenNewestFirstMessages,
  formatNewMessages,
  getChatReadState,
  isAtNewestEdge,
  saveChatReadState,
} from "~/lib/chat-read-state";
import { buildChatSummary } from "~/lib/chat-summary";
import {
  getChat,
  getChatTokenUsage,
  listChatMessages,
  markMeChatRead,
  type PaginatedMessages,
  renameChat,
  sendChatMessage,
} from "~/lib/chats-api";
import { clearDraft, loadDrafts, saveDraft } from "~/lib/drafts";
import { loadLiquidGlass } from "~/lib/liquid-glass";
import {
  buildMentionCandidates,
  buildMentionInsert,
  buildMentionSections,
  composerPlaceholder,
  computeRequiresMention,
  type DirectoryCandidate,
  findActiveMentionTrigger,
  findSolePeerAgentId,
  isSelfOnlySpeakerRoster,
  pickPrimaryAgent,
  rankMentionCandidates,
  shouldPrimeMentionOnFocus,
} from "~/lib/mentions";
import { buildParticipantRoster, summarizeParticipants } from "~/lib/participants";
import { colors } from "~/lib/theme";
import { formatTokenCount, processedTokenCount } from "~/lib/token-usage";
import { useAddParticipant, useDirectoryCandidates } from "~/lib/use-add-participant";
import { useAgentRuntimeSummaries } from "~/lib/use-agent-runtime";

const PAGE_SIZE = 50;

/** VirtualizedList captures these once; they must never change identity. */
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 50 } as const;

type TimelineItem =
  | { kind: "message"; key: string; message: Message }
  | { kind: "divider"; key: string; count: number };

type MessagesCache = InfiniteData<PaginatedMessages, string | undefined>;

/** Timeline rows are messages or the unread ribbon; only the former carry an id. */
function timelineMessageId(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const row = item as { kind?: unknown; message?: { id?: unknown } };
  return row.kind === "message" && typeof row.message?.id === "string" ? row.message.id : null;
}

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
  // One-shot: the visit's opening position is chosen once, never re-applied
  // when later messages arrive.
  const openedAtUnreadRef = useRef(false);
  const autoPrimedDraftRef = useRef(false);
  const readLoadedRef = useRef(false);
  const bottomVisibleRef = useRef<string | null>(null);
  const latestKnownRef = useRef<string | null>(null);
  const serverSyncedRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [frozenUnreadAnchorId, setFrozenUnreadAnchorId] = useState<string | null>(null);
  const [sessionHighestId, setSessionHighestId] = useState<string | null>(null);
  const [readReady, setReadReady] = useState(false);
  const [message, setMessage] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [composerFooterHeight, setComposerFooterHeight] = useState(0);
  // The header floats over the timeline, so the list needs its height as
  // clearance rather than the header taking a row out of the conversation.
  const [headerHeight, setHeaderHeight] = useState(0);
  // Deterministic keyboard avoidance: lift the composer by the exact
  // keyboard height. Framework avoidance (KeyboardAvoidingView /
  // automaticallyAdjustKeyboardInsets) mis-measured or left the composer
  // behind the keyboard on iOS.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const scrollOffsetRef = useRef(0);
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

  // The timeline renders inverted: index 0 is the newest message and scroll
  // offset 0 is the bottom of the screen. That makes "show the newest message"
  // a fixed coordinate instead of a scrollToIndex into markdown bubbles whose
  // heights are still being measured — which is what used to drop the reader
  // at a random position on open and yank them back to the previous message
  // after sending.
  const scrollToNewest = useCallback((animated: boolean) => {
    listRef.current?.scrollToOffset({ offset: 0, animated });
  }, []);

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

    void getChatReadState(chatId).then((previousState) => {
      if (!active) return;
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
    // Slack's rule: a thread reply lives in its thread. Clarifications and the
    // answer render under the ask they belong to, so they do not also appear
    // loose in the conversation.
    const threadIds = threadDescendantIds(messages, collectRequestIds(messages));
    const messageItems = messages
      .filter((message) => !threadIds.has(message.id))
      .map((message): TimelineItem => ({ kind: "message", key: message.id, message }));
    if (dividerInsertIndex < 0) return messageItems;
    const divider: TimelineItem = { kind: "divider", key: "unread-divider", count: unreadCount };
    return [...messageItems.slice(0, dividerInsertIndex), divider, ...messageItems.slice(dividerInsertIndex)];
  }, [dividerInsertIndex, messages, unreadCount]);
  // The list renders inverted, so it consumes the same rows newest-first.
  const invertedTimeline = useMemo<TimelineItem[]>(() => [...timeline].reverse(), [timeline]);

  // Open on the unread boundary, not blindly on the newest message: the
  // ribbon lands at the top of the screen with the unread messages below it,
  // so the reader starts where they stopped. Inverted coordinates keep this
  // cheap — the rows between the tip and the ribbon are exactly the unread
  // ones, so nothing has to measure the whole history to get there (which is
  // what made the old oldest-first anchor land at a random offset). With
  // nothing unread the natural offset 0 already is the newest message.
  useEffect(() => {
    if (openedAtUnreadRef.current || !readReady || invertedTimeline.length === 0) return;
    openedAtUnreadRef.current = true;
    const dividerIndex = invertedTimeline.findIndex((row) => row.kind === "divider");
    if (dividerIndex < 0) return;
    // A clamped scroll (everything unread already fits on screen) simply
    // leaves the list at the tip, which is the right answer there.
    requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: dividerIndex, viewPosition: 1, animated: false });
    });
  }, [invertedTimeline, readReady]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId changes when the route switches chats.
  useEffect(() => {
    openedAtUnreadRef.current = false;
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

  // Unsent text survives leaving the chat, on this device only. Restored once
  // per visit, then written behind a short debounce so typing is not a write
  // per keystroke.
  const draftLoadedRef = useRef(false);
  useEffect(() => {
    draftLoadedRef.current = false;
    void loadDrafts().then((drafts) => {
      if (draftLoadedRef.current) return;
      draftLoadedRef.current = true;
      const stored = drafts.find((draft) => draft.chatId === chatId);
      if (stored) setMessage((current) => (current.length > 0 ? current : stored.text));
    });
  }, [chatId]);
  useEffect(() => {
    if (!draftLoadedRef.current) return;
    const timer = setTimeout(() => {
      void saveDraft(chatId, chat?.title ?? "", message).then(() =>
        queryClient.invalidateQueries({ queryKey: ["drafts"] }),
      );
    }, 500);
    return () => clearTimeout(timer);
  }, [chat?.title, chatId, message, queryClient]);

  // Roster ordered by who spoke last: the header names the currently active
  // people first, and the sheet spells the same order out with activity times.
  const participantRoster = useMemo(
    () =>
      buildParticipantRoster(chat?.participants ?? [], messages, { agentId: selfAgentId, senderIds: selfSenderIds }),
    [chat?.participants, messages, selfAgentId, selfSenderIds],
  );
  const headerPeer = useMemo(
    () => participantRoster.find((row) => !row.isSelf)?.participant ?? null,
    [participantRoster],
  );
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The agent-authored current-state brief on `chat.description`.
  const chatSummary = useMemo(() => (chat ? buildChatSummary(chat) : null), [chat]);

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
  const PickerSurface = ComposerSurface ?? View;
  const HeaderSurface = ComposerSurface ?? View;

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

  // Org identities the author could pull into the chat, searched only while
  // an `@` is actually open.
  const { candidates: directoryCandidates } = useDirectoryCandidates({
    query: activeMentionTrigger?.query ?? "",
    enabled: activeMentionTrigger != null,
    selfAgentId,
  });
  const mentionSections = useMemo(
    () =>
      activeMentionTrigger
        ? buildMentionSections({
            participants: mentionCandidates,
            directory: directoryCandidates,
            query: activeMentionTrigger.query,
          })
        : [],
    [activeMentionTrigger, directoryCandidates, mentionCandidates],
  );
  const addFlow = useAddParticipant(chatId);
  const pickerAgentIds = useMemo(
    () => mentionSections.flatMap((section) => section.rows.map((row) => row.agentId)),
    [mentionSections],
  );
  const pickerRuntimes = useAgentRuntimeSummaries(pickerAgentIds, { enabled: activeMentionTrigger != null });

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

  // Add, then mention: the flow refreshes the roster before it resolves, so
  // the draft's `@name` resolves against a roster that contains them.
  const confirmAddAndMention = useCallback(async () => {
    const added = await addFlow.confirm();
    if (added) applyMentionPick(added);
  }, [addFlow, applyMentionPick]);

  // Abandoning the `@` token abandons the pending add with it; a stale
  // confirmation would otherwise sit over an unrelated draft.
  useEffect(() => {
    if (activeMentionTrigger) return;
    addFlow.cancel();
  }, [activeMentionTrigger, addFlow.cancel]);

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
    void clearDraft(chatId).then(() => queryClient.invalidateQueries({ queryKey: ["drafts"] }));
    setSending(true);
    setSendError(null);
    // Sending re-attaches the view to the newest message even if the reader
    // had scrolled up to look back through the thread.
    scrollToNewest(false);

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
      scrollToNewest(true);
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
  }, [
    effectiveSendMentions,
    message,
    memberId,
    openAsk,
    queryClient,
    scrollToNewest,
    sendBlockedByMentionGate,
    sending,
    chatId,
  ]);
  const isLoading = chatQuery.isLoading || messagesQuery.isLoading;
  const error = chatQuery.error ?? messagesQuery.error;
  // Parked at the newest edge means everything is read: there is nothing below
  // the fold for the "N new messages" pill to point at.
  const syncReadAtNewestEdge = useCallback(() => {
    if (!readReady) return;
    if (!isAtNewestEdge(scrollOffsetRef.current)) return;
    const newest = messages[messages.length - 1];
    if (!newest) return;
    bottomVisibleRef.current = newest.id;
    setSessionHighestId((previous) => (previous === newest.id ? previous : newest.id));
    scheduleReadStateSave();
  }, [messages, readReady, scheduleReadStateSave]);

  // In inverted coordinates the lowest visible index is the newest message the
  // reader has actually reached; everything newer than it is still unread.
  const onViewableItems = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const newestVisible = viewableItems.reduce<ViewToken | null>((best, token) => {
        if (!token.isViewable || token.index == null) return best;
        return best == null || token.index < (best.index ?? Number.POSITIVE_INFINITY) ? token : best;
      }, null);
      const messageId = timelineMessageId(newestVisible?.item);
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
    [messages, scheduleReadStateSave],
  );
  // VirtualizedList refuses to swap this callback after mount, so the list
  // gets one stable function that forwards to the current closure.
  const viewableItemsRef = useRef(onViewableItems);
  viewableItemsRef.current = onViewableItems;
  const handleViewableItemsChanged = useCallback((info: { viewableItems: ViewToken[] }) => {
    viewableItemsRef.current(info);
  }, []);

  return (
    <View style={styles.container}>
      <HeaderSurface
        style={[styles.header, ComposerSurface ? styles.headerGlass : styles.headerOpaque]}
        {...(ComposerSurface ? { glassEffectStyle: "regular" as const, colorScheme: "dark" as const } : {})}
        onLayout={({ nativeEvent: { layout } }: LayoutChangeEvent) => setHeaderHeight(layout.height)}
      >
        <View style={[styles.headerBar, { paddingTop: safeAreaInsets.top + 6 }]}>
          {showBack && (
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              accessibilityLabel="Back"
              style={({ pressed }) => [styles.circleButton, pressed && styles.circleButtonPressed]}
            >
              <Ionicons name="chevron-back" size={20} color={colors.text} />
            </Pressable>
          )}
          <Pressable
            style={styles.headerIdentity}
            onPress={() => setParticipantsOpen(true)}
            onLongPress={() => setDetailsOpen(true)}
            disabled={participantRoster.length === 0}
            accessibilityRole="button"
            accessibilityLabel="Show participants"
          >
            <Avatar
              name={headerPeer?.displayName ?? chat?.title ?? chatId}
              seed={headerPeer?.agentId ?? chatId}
              colorToken={headerPeer?.avatarColorToken ?? null}
              imageUrl={headerPeer?.avatarImageUrl ?? null}
              kind={headerPeer?.type === "human" ? "human" : "agent"}
              size={32}
            />
            <View style={styles.headerText}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {chat?.title ?? chatId.slice(0, 8)}
              </Text>
              {participantRoster.length > 0 && (
                <Text style={styles.headerSubtitle} numberOfLines={1}>
                  {summarizeParticipants(participantRoster)}
                </Text>
              )}
            </View>
          </Pressable>
          <Pressable
            onPress={() => setDetailsOpen(true)}
            hitSlop={8}
            accessibilityLabel="Chat details"
            style={({ pressed }) => [styles.circleButton, pressed && styles.circleButtonPressed]}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={colors.text} />
            {/* A Summary written since the last visit is the one thing worth
                advertising from behind the menu. */}
            {chatSummary?.isUnread && <View style={styles.headerDot} />}
          </Pressable>
        </View>
      </HeaderSurface>

      <ChatDetailsSheet
        visible={detailsOpen}
        chatId={chatId}
        title={chat?.title ?? chatId.slice(0, 8)}
        summary={chatSummary}
        onRename={() => {
          setDetailsOpen(false);
          setRenameOpen(true);
        }}
        onClose={() => setDetailsOpen(false)}
      />

      <RenameChatModal
        visible={renameOpen}
        initialTitle={chat?.topic ?? chat?.title ?? ""}
        onCancel={() => setRenameOpen(false)}
        onSubmit={async (topic) => {
          await renameChat(chatId, topic);
          await queryClient.invalidateQueries({ queryKey: ["chats", chatId] });
          void queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
          setRenameOpen(false);
        }}
      />

      <ChatParticipantsSheet
        visible={participantsOpen}
        rows={participantRoster}
        chatId={chatId}
        selfAgentId={selfAgentId}
        onClose={() => setParticipantsOpen(false)}
      />

      {isLoading && (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      )}

      {error && !isLoading && (
        <View style={[styles.errorBox, { marginTop: headerHeight }]}>
          <Text style={styles.errorText}>{error instanceof Error ? error.message : "Failed to load chat"}</Text>
          <Pressable onPress={() => void chatQuery.refetch()} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        ref={listRef}
        style={styles.timeline}
        data={invertedTimeline}
        inverted
        keyExtractor={(item) => item.key}
        // Newest-first data means arrivals land at index 0. Hold the reader's
        // place when they are reading history, and follow the tip when they
        // are already near it.
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 120 }}
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
            itemMessage.format === "request" ? (
              <View style={styles.askThreadRow}>
                <AskThread chatId={chatId} requestId={itemMessage.id} question={itemMessage} />
              </View>
            ) : itemMessage.format === "card" ? (
              <MessageCard message={itemMessage} />
            ) : (
              <ChatMessageBubble
                message={itemMessage}
                isMe={itemMessage.senderId === memberId || itemMessage.senderId === user?.id}
                senderName={participantNames(itemMessage.senderId)}
                avatar={toBubbleAvatar(itemMessage.senderId)}
              />
            );
          return messageView;
        }}
        // Scrolling up in an inverted list runs toward the end of the data,
        // so older pages load here. Appending them leaves the visible rows
        // exactly where they are.
        onEndReached={() => {
          if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
            void messagesQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        // The list is flipped, so the composer's clearance is a spacer at the
        // head of the data rather than contentContainer padding.
        ListHeaderComponent={<View style={{ height: Math.max(8, composerReserve + 12) }} />}
        // Inverted: the container's bottom padding lands at the visual top,
        // which is where the floating header needs its clearance.
        contentContainerStyle={[styles.messages, { paddingBottom: headerHeight + 8 }]}
        scrollEventThrottle={16}
        onScroll={({ nativeEvent: { contentOffset } }) => {
          scrollOffsetRef.current = contentOffset.y;
          syncReadAtNewestEdge();
        }}
        onViewableItemsChanged={handleViewableItemsChanged}
        viewabilityConfig={VIEWABILITY_CONFIG}
        onScrollToIndexFailed={({ index }) => {
          // Bubble heights are dynamic, so the first estimate for a row that
          // has not been laid out yet can miss. Retry once the rows below it
          // have measured, then give up rather than chasing the reader.
          setTimeout(() => {
            listRef.current?.scrollToIndex({ index, viewPosition: 1, animated: false });
          }, 60);
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
          {activeMentionTrigger && mentionSections.length > 0 && (
            // Same material as the composer it sits on when the device has
            // Liquid Glass: glass blurs and desaturates the timeline behind
            // it, so names stay legible instead of colliding with message
            // text. Everywhere else (Android, web, pre-26 iOS, an older dev
            // client) falls back to the opaque panel.
            <PickerSurface
              style={[styles.mentionPicker, ComposerSurface ? styles.mentionPickerGlass : null]}
              {...(ComposerSurface ? { glassEffectStyle: "regular" as const, colorScheme: "dark" as const } : {})}
            >
              {addFlow.pending ? (
                <AddParticipantConfirm
                  flow={addFlow}
                  confirmLabel="Add and mention"
                  onConfirm={() => void confirmAddAndMention()}
                />
              ) : (
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  style={styles.mentionList}
                  contentContainerStyle={styles.mentionListContent}
                >
                  {mentionSections.map((section) => (
                    <View key={section.key}>
                      <Text style={styles.mentionSectionTitle}>{section.title}</Text>
                      {section.rows.map((candidate) => (
                        <Pressable
                          key={candidate.agentId}
                          onPress={() =>
                            section.key === "participants"
                              ? applyMentionPick(candidate)
                              : addFlow.request(candidate as DirectoryCandidate)
                          }
                          style={({ pressed }) => [styles.mentionRow, pressed && styles.mentionRowPressed]}
                        >
                          <Avatar
                            name={candidate.displayName}
                            seed={candidate.agentId}
                            size={24}
                            colorToken={"avatarColorToken" in candidate ? candidate.avatarColorToken : null}
                            imageUrl={"avatarImageUrl" in candidate ? candidate.avatarImageUrl : null}
                            kind={"type" in candidate && candidate.type === "human" ? "human" : "agent"}
                          />
                          <View style={styles.mentionLabels}>
                            <View style={styles.mentionNameLine}>
                              <Text style={styles.mentionDisplayName} numberOfLines={1}>
                                {candidate.displayName}
                              </Text>
                              <Text style={styles.mentionName} numberOfLines={1}>
                                @{candidate.name}
                              </Text>
                            </View>
                            <AgentMetaLine summary={pickerRuntimes.get(candidate.agentId)} />
                          </View>
                          {section.key === "directory" && <Text style={styles.mentionAddHint}>Add</Text>}
                        </Pressable>
                      ))}
                    </View>
                  ))}
                </ScrollView>
              )}
            </PickerSurface>
          )}
          {/* The one writing surface, shared with the ask screen. */}
          <ComposerField
            ref={composerRef}
            header={
              showTokenUsage && processedTokens > 0 ? (
                <Text style={styles.tokenUsage}>{formatTokenCount(processedTokens)} processed tokens in this chat</Text>
              ) : null
            }
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
      )}

      {unreadLabel && (
        <Pressable
          onPress={() => scrollToNewest(true)}
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
    position: "absolute",
    top: 0,
    right: 0,
    left: 0,
    zIndex: 5,
  },
  headerGlass: {
    // The material is the background; a color on top would flatten it.
    backgroundColor: "transparent",
  },
  headerOpaque: {
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 8,
  },
  circleButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceStrong,
  },
  circleButtonPressed: {
    backgroundColor: colors.surface,
  },
  headerIdentity: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerDot: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
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
  askThreadRow: {
    paddingHorizontal: 12,
    paddingVertical: 6,
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
    // Fallback panel: opaque, because a translucent flat overlay let message
    // text show through and collide with the candidate names.
    backgroundColor: colors.surfaceFloating,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  mentionPickerGlass: {
    // The material supplies its own surface; a background color on top of it
    // would flatten the glass back into a tinted panel.
    backgroundColor: "transparent",
    borderRadius: 20,
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
  mentionSectionTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 2,
  },
  mentionAddHint: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "600",
  },
  mentionLabels: {
    flex: 1,
    gap: 1,
  },
  mentionNameLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  mentionDisplayName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  mentionName: {
    color: colors.textMuted,
    fontSize: 12,
    flexShrink: 1,
  },
});
