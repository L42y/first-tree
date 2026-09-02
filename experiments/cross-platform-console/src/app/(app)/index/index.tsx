import type { MeChatRow } from "@first-tree/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  type FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatDetailContent } from "~/components/chat-detail";
import { ChatListItem } from "~/components/chat-list-item";
import { ChatListSkeleton } from "~/components/chat-list-item-skeleton";
import { CollapsingHeaderBar, LargeTitle, useCollapsingHeaderScroll } from "~/components/collapsing-header";
import { QuickActionsButton } from "~/components/quick-actions";
import { useAuth } from "~/lib/auth-context";
import { fetchChatRowsPage, renameChat, setChatEngagement } from "~/lib/chats-api";
import { getItem, setItem } from "~/lib/storage";
import { useTabBarFloatingInset } from "~/lib/tab-bar-inset";
import { colors } from "~/lib/theme";

// Scroll memory per (view, filter). Held in memory for the fast path and
// mirrored to storage so the position also survives an app restart — the
// server tracks read and pin state, never the viewport.
const SCROLL_OFFSETS_KEY = "chat-list:scroll-offsets";
const scrollOffsetMap: Record<string, number> = {};

let scrollOffsetsHydrated = false;
let scrollHydration: Promise<void> | null = null;

function hydrateScrollOffsets(): Promise<void> {
  if (scrollOffsetsHydrated) return Promise.resolve();
  if (!scrollHydration) {
    scrollHydration = getItem<Record<string, unknown>>(SCROLL_OFFSETS_KEY)
      .then((stored) => {
        for (const [key, value] of Object.entries(stored ?? {})) {
          if (typeof value === "number" && Number.isFinite(value)) {
            scrollOffsetMap[key] = value;
          }
        }
      })
      .finally(() => {
        scrollOffsetsHydrated = true;
      });
  }
  return scrollHydration;
}

// onScroll fires per frame; coalesce writes so storage isn't thrashed.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistScrollOffsets(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void setItem(SCROLL_OFFSETS_KEY, scrollOffsetMap).catch(() => undefined);
  }, 500);
}

type ListItem = { kind: "header"; id: string; label: string } | { kind: "chat"; id: string; row: MeChatRow };

export default function ChatListScreen() {
  const listRef = useRef<FlatList<ListItem> | null>(null);
  const restorePendingRef = useRef(true);
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;
  const tabBarInset = useTabBarFloatingInset();
  const insets = useSafeAreaInsets();
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const { user, agentId: selfAgentId } = useAuth();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [view, setView] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [scrollReady, setScrollReady] = useState(scrollOffsetsHydrated);

  // Restoring before the stored offsets land would scroll to a stale (or
  // absent) position, so the first restore waits on hydration.
  useEffect(() => {
    let active = true;
    void hydrateScrollOffsets().then(() => {
      if (active) setScrollReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Each (view, filter) pair keeps its own position, so switching tabs must
  // re-arm the restore for the newly selected key.
  useEffect(() => {
    restorePendingRef.current = true;
  }, [view, filter]);

  const restoreScrollIfPending = useCallback(() => {
    if (!scrollReady || !restorePendingRef.current) return;
    restorePendingRef.current = false;
    const saved = scrollOffsetMap[`${view}:${filter}`];
    if (!saved || saved <= 4) return;
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: saved, animated: false }));
  }, [scrollReady, view, filter]);

  // Hydration usually resolves after the list has already sized itself, so
  // onContentSizeChange alone would never fire again to restore the offset.
  useEffect(() => {
    restoreScrollIfPending();
  }, [restoreScrollIfPending]);

  const { data, isLoading, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["me", "chats", "list", filter, view],
    queryFn: ({ pageParam, signal }) => fetchChatRowsPage(filter, pageParam, signal, view),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  // Cross-page dedupe: a chat can shift pages between requests as its
  // activity changes, so guard against handing FlatList a duplicate id.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: MeChatRow[] = [];
    for (const page of data?.pages ?? []) {
      for (const row of page.rows) {
        if (seen.has(row.chatId)) continue;
        seen.add(row.chatId);
        out.push(row);
      }
    }
    return out;
  }, [data]);

  // Chats with an open ask for you outrank everything (own section),
  // then pinned chats, then the rest.
  // Client-side filter over title/preview/participants — instant, no server
  // round-trip.
  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [
        row.title,
        row.description ?? "",
        row.lastMessagePreview ?? "",
        ...row.participants.map((p) => p.displayName),
      ].some((field) => field.toLowerCase().includes(needle)),
    );
  }, [rows, search]);

  const listItems = useMemo<ListItem[]>(() => {
    const needsYou = visibleRows.filter((r) => r.openRequestCount > 0);
    const needsYouIds = new Set(needsYou.map((r) => r.chatId));
    const pinned = visibleRows.filter(
      (r) => !needsYouIds.has(r.chatId) && r.pinnedAt !== null && r.pinnedAt !== undefined,
    );
    const rest = visibleRows.filter((r) => !needsYouIds.has(r.chatId) && !pinned.includes(r));
    const items: ListItem[] = [];
    if (needsYou.length > 0) {
      items.push({ kind: "header", id: "header-needs-you", label: "Needs your answer" });
      for (const row of needsYou) items.push({ kind: "chat", id: row.chatId, row });
    }
    if (pinned.length > 0) {
      items.push({ kind: "header", id: "header-pinned", label: "Pinned" });
      for (const row of pinned) items.push({ kind: "chat", id: row.chatId, row });
    }
    if (rest.length > 0) {
      items.push({ kind: "header", id: "header-all", label: "All" });
      for (const row of rest) items.push({ kind: "chat", id: row.chatId, row });
    }
    return items;
  }, [visibleRows]);

  const renameRow = useCallback(
    (row: MeChatRow) => {
      if (Platform.OS !== "ios") return; // Alert.prompt is iOS-only in this experiment
      Alert.prompt(
        "Rename chat",
        undefined,
        (text: string) => {
          const topic = text?.trim();
          if (!topic) return;
          void renameChat(row.chatId, topic).then(() =>
            queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] }),
          );
        },
        undefined,
        row.title,
      );
    },
    [queryClient],
  );

  useEffect(() => {
    restorePendingRef.current = true;
  }, [filter, view]);

  const archiveRow = useCallback(
    (row: MeChatRow) => {
      const archived = row.engagementStatus === "archived";
      void setChatEngagement(row.chatId, archived ? "active" : "archived").then(() =>
        queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] }),
      );
    },
    [queryClient],
  );

  const rowActions = useCallback(
    (row: MeChatRow) => {
      Alert.alert(row.title, undefined, [
        { text: "Cancel", style: "cancel" },
        { text: "Rename", onPress: () => renameRow(row) },
        {
          text: row.engagementStatus === "archived" ? "Unarchive" : "Archive",
          onPress: () => archiveRow(row),
        },
      ]);
    },
    [renameRow, archiveRow],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const { scrollY, onScroll } = useCollapsingHeaderScroll((e) => {
    scrollOffsetMap[`${view}:${filter}`] = e.nativeEvent.contentOffset.y;
    persistScrollOffsets();
  });

  // The list must be the screen's sole/first native child (react-native-screens
  // walks subview[0] down from the screen root to find the scroll view it
  // ties the large-title collapse animation to) — everything that used to sit
  // above the list as a sibling now rides inside it via ListHeaderComponent.
  const listHeader = (
    <View>
      <LargeTitle scrollY={scrollY}>Chats</LargeTitle>
      <View style={styles.filters}>
        <Pressable onPress={() => setFilter("all")} style={[styles.filter, filter === "all" && styles.filterActive]}>
          <Text style={[styles.filterText, filter === "all" && styles.filterActiveText]}>All</Text>
        </Pressable>
        <Pressable
          onPress={() => setFilter("unread")}
          style={[styles.filter, filter === "unread" && styles.filterActive]}
        >
          <Text style={[styles.filterText, filter === "unread" && styles.filterActiveText]}>Unread</Text>
        </Pressable>
      </View>

      {(rows.length > 0 || search.length > 0) && (
        <TextInput
          style={styles.search}
          placeholder="Search chats…"
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}
    </View>
  );

  const listEmpty =
    isLoading && !data ? (
      <ChatListSkeleton />
    ) : error ? (
      <View style={styles.errorBox}>
        <Text style={styles.errorText}>{error instanceof Error ? error.message : "Failed to load chats"}</Text>
        <Pressable onPress={() => refetch()} style={styles.retryButton}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    ) : listItems.length === 0 ? (
      <Text style={styles.empty}>{user?.displayName ? `No chats for ${user.displayName} yet.` : "No chats yet."}</Text>
    ) : null;

  const listFooter = isFetchingNextPage ? (
    <View style={styles.footer}>
      <ActivityIndicator color={colors.textMuted} />
    </View>
  ) : null;

  const listPane = (
    <View style={[styles.container, isWide && styles.listPane]}>
      <Animated.FlatList
        ref={listRef}
        data={listItems}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={restoreScrollIfPending}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: tabBarInset }}
        keyExtractor={(item: ListItem) => item.id}
        renderItem={({ item }: { item: ListItem }) =>
          item.kind === "header" ? (
            <Text style={styles.sectionHeader}>{item.label}</Text>
          ) : (
            <ChatListItem
              chat={item.row}
              selfAgentId={selfAgentId}
              onPressChat={isWide ? setSelectedChatId : undefined}
              onLongPressChat={rowActions}
            />
          )
        }
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        // Only paginate the unfiltered feed — once the user types a search
        // query it's scoped to rows already loaded, so pulling in more pages
        // wouldn't reliably extend those results anyway.
        onEndReached={() => {
          if (!search && hasNextPage && !isFetchingNextPage) void fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
      />
      <CollapsingHeaderBar title="Chats" scrollY={scrollY} headerRight={<QuickActionsButton />} />
    </View>
  );

  if (isWide) {
    return (
      <View style={[styles.twoPane, styles.container]}>
        {listPane}
        <View style={styles.detailPane}>
          {selectedChatId ? (
            <ChatDetailContent chatId={selectedChatId} showBack={false} />
          ) : (
            <View style={styles.emptyPane}>
              <Text style={styles.emptyPaneText}>Select a conversation</Text>
            </View>
          )}
        </View>
      </View>
    );
  }
  return listPane;
}

const styles = StyleSheet.create({
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  search: {
    marginHorizontal: 16,
    marginTop: 8,
    minHeight: 38,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  twoPane: {
    flexDirection: "row",
  },
  listPane: {
    maxWidth: 400,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
  },
  detailPane: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  emptyPane: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyPaneText: {
    color: colors.textMuted,
    fontSize: 15,
  },
  filters: {
    flexDirection: "row",
    padding: 8,
    gap: 8,
  },
  filter: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  filterActive: {
    backgroundColor: colors.accent,
  },
  filterText: {
    color: colors.text,
  },
  filterActiveText: {
    color: colors.accentText,
    fontWeight: "bold",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
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
  empty: {
    textAlign: "center",
    opacity: 0.6,
    padding: 24,
  },
  footer: {
    paddingVertical: 20,
  },
});
