import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { useQuery } from "@tanstack/react-query";
import { Pressable } from "react-native";

import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import { listMeChats } from "~/lib/chats-api";
import { useAuth } from "~/lib/auth-context";
import { ChatListItem } from "~/components/chat-list-item";
import { colors } from "~/lib/theme";

const PAGE_SIZE = 50;

function flattenChats(data?: ListMeChatsResponse): MeChatRow[] {
  if (!data) return [];
  const pinnedIds = new Set(data.priorityRows.pinned.map((row) => row.chatId));
  const others = data.rows.filter((row) => !pinnedIds.has(row.chatId));
  return [...data.priorityRows.pinned, ...others];
}

export default function ChatListScreen() {
  const { logout, teamDisplayName, user, agentId: selfAgentId } = useAuth();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["me", "chats", "list", filter],
    queryFn: async ({ signal }) => {
      const collected: MeChatRow[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await listMeChats(
          { limit: PAGE_SIZE, cursor: cursor ?? undefined, filter },
          { signal },
        );
        for (const row of flattenChats(page)) {
          // A chat can surface in two pages (e.g. pinned on one, listed on
          // the next) — dedupe so FlatList keys stay unique.
          if (seen.has(row.chatId)) continue;
          seen.add(row.chatId);
          collected.push(row);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return collected;
    },
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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Chats</Text>
          {teamDisplayName && (
            <Text style={styles.subtitle}>{teamDisplayName}</Text>
          )}
        </View>
        <Pressable onPress={() => void logout()} style={styles.logoutButton}>
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
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
        data={rows}
        keyExtractor={(item: MeChatRow) => item.chatId}
        renderItem={({ item }: { item: MeChatRow }) => <ChatListItem chat={item} selfAgentId={selfAgentId} />}
        estimatedItemSize={76}
        recycleItems
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.textMuted}
          />
        }
        ListEmptyComponent={
          !isLoading && rows.length === 0 ? (
            <Text style={styles.empty}>
              {user?.displayName ? `No chats for ${user.displayName} yet.` : "No chats yet."}
            </Text>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
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
  logoutButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  logoutText: {
    fontSize: 13,
    color: colors.text,
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
