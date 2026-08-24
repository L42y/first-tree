import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  TextInput,
  Text,
  View,
} from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable } from "react-native";

import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import { useRouter } from "expo-router";
import { fetchChatRows, renameChat, setChatEngagement } from "~/lib/chats-api";
import { useAuth } from "~/lib/auth-context";
import { ChatListItem } from "~/components/chat-list-item";
import { ChatDetailContent } from "~/components/chat-detail";
import { QuickActions } from "~/components/quick-actions";
import { colors } from "~/lib/theme";

const PAGE_SIZE = 50;

function flattenChats(data?: ListMeChatsResponse): MeChatRow[] {
  if (!data) return [];
  const pinnedIds = new Set(data.priorityRows.pinned.map((row) => row.chatId));
  const others = data.rows.filter((row) => !pinnedIds.has(row.chatId));
  return [...data.priorityRows.pinned, ...others];
}

// Session-scope scroll memory per (view, filter) — survives tab switches
// and refetches; resets on app restart (server stores read/pin, not viewport).
const scrollOffsetMap: Record<string, number> = {};

export default function ChatListScreen() {
  const listRef = useRef<FlatList<never> | null>(null);
  const restorePendingRef = useRef(true);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const { teamDisplayName, user, agentId: selfAgentId } = useAuth();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [view, setView] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["me", "chats", "list", filter, view],
    // Polling refetches produce fresh array identities; without this the
    // list visibly jumps every interval.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchChatRows(filter, signal, view),
  });

  // Render-time guard: a cached array fetched before the page-level
  // dedupe may still contain repeated chat ids — never hand duplicates to
  // FlatList.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (data ?? []).filter((row) => {
      if (seen.has(row.chatId)) return false;
      seen.add(row.chatId);
      return true;
    });
  }, [data]);

  type ListItem =
    | { kind: "header"; id: string; label: string }
    | { kind: "chat"; id: string; row: MeChatRow };

  // Chats with an open ask for you outrank everything (own section),
  // then pinned chats, then the rest.
  // Client-side filter over title/preview/participants — instant, no server
  // round-trip.
  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.title, row.description ?? "", row.lastMessagePreview ?? "", ...row.participants.map((p) => p.displayName)]
        .some((field) => field.toLowerCase().includes(needle)),
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
      Alert.prompt("Rename chat", undefined, (text: string) => {
        const topic = text?.trim();
        if (!topic) return;
        void renameChat(row.chatId, topic).then(() =>
          queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] }),
        );
      }, undefined, row.title);
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

  const listPane = (
    <View style={[styles.container, isWide && styles.listPane]}>
      <View style={styles.header}>
        <Pressable onPress={() => setQuickOpen(true)} hitSlop={8} style={styles.quickButton}>
          <Text style={styles.quickButtonText}>Quick</Text>
        </Pressable>
        <View>
          <Text style={styles.title}>Chats</Text>
          {teamDisplayName && (
            <Text style={styles.subtitle}>{teamDisplayName}</Text>
          )}
        </View>
      </View>

      <View style={styles.filters}>
        <Pressable
          onPress={() => setFilter("all")}
          style={[styles.filter, filter === "all" && styles.filterActive]}
        >
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

      {isLoading && !data && (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            {error instanceof Error ? error.message : "Failed to load chats"}
          </Text>
          <Pressable onPress={() => refetch()} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      <LegendList
        ref={listRef as never}
        data={listItems}
        onScroll={(e: { nativeEvent: { contentOffset: { y: number } } }) => {
          scrollOffsetMap[`${view}:${filter}`] = e.nativeEvent.contentOffset.y;
        }}
        onContentSizeChange={() => {
          if (!restorePendingRef.current) return;
          restorePendingRef.current = false;
          const saved = scrollOffsetMap[`${view}:${filter}`];
          if (saved && saved > 4) {
            requestAnimationFrame(() =>
              (listRef.current as unknown as { scrollToOffset: (o: { offset: number; animated: boolean }) => void })?.scrollToOffset({
                offset: saved,
                animated: false,
              }),
            );
          }
        }}
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
        estimatedItemSize={76}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.textMuted}
          />
        }
        ListEmptyComponent={
          !isLoading && listItems.length === 0 ? (
            <Text style={styles.empty}>
              {user?.displayName ? `No chats for ${user.displayName} yet.` : "No chats yet."}
            </Text>
          ) : null
        }
      />

      <QuickActions visible={quickOpen} onClose={() => setQuickOpen(false)} />
    </View>
  );

  if (isWide) {
    return (
      <View style={[styles.twoPane, styles.container]}>
        {listPane}
        <View style={styles.detailPane}>
          {selectedChatId ? (
            <ChatDetailContent
              chatId={selectedChatId}
              showBack={false}
              expectAsk={(rows.find((r) => r.chatId === selectedChatId)?.openRequestCount ?? 0) > 0}
            />
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
  quickButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.accent,
    marginRight: 10,
  },
  quickButtonText: {
    color: colors.accentText,
    fontWeight: "700",
    fontSize: 12,
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.text,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 12,
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
});
