import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Pressable } from "react-native";

import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import { listMeChats } from "~/lib/chats-api";
import { useAuth } from "~/lib/auth-context";
import { ChatListItem } from "~/components/chat-list-item";

const PAGE_SIZE = 50;

function flattenChats(data?: ListMeChatsResponse): MeChatRow[] {
  if (!data) return [];
  const pinnedIds = new Set(data.priorityRows.pinned.map((row) => row.chatId));
  const others = data.rows.filter((row) => !pinnedIds.has(row.chatId));
  return [...data.priorityRows.pinned, ...others];
}

export default function ChatListScreen() {
  const { logout, teamDisplayName, user } = useAuth();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["me", "chats", "list", filter],
    queryFn: async ({ signal }) => {
      const rows: MeChatRow[] = [];
      let cursor: string | null = null;
      do {
        const page = await listMeChats(
          { limit: PAGE_SIZE, cursor: cursor ?? undefined, filter },
          { signal },
        );
        rows.push(...flattenChats(page));
        cursor = page.nextCursor;
      } while (cursor);
      return rows;
    },
  });

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
          <Text style={filter === "all" ? styles.filterActiveText : undefined}>All</Text>
        </Pressable>
        <Pressable
          onPress={() => setFilter("unread")}
          style={[styles.filter, filter === "unread" && styles.filterActive]}
        >
          <Text style={filter === "unread" ? styles.filterActiveText : undefined}>Unread</Text>
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

      <FlatList
        data={data ?? []}
        keyExtractor={(item) => item.chatId}
        renderItem={({ item }) => <ChatListItem chat={item} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          !isLoading ? (
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
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(128,128,128,0.2)",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
  },
  subtitle: {
    opacity: 0.6,
    fontSize: 12,
  },
  logoutButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(128,128,128,0.15)",
  },
  logoutText: {
    fontSize: 13,
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
    backgroundColor: "rgba(128,128,128,0.1)",
  },
  filterActive: {
    backgroundColor: "#3B82F6",
  },
  filterActiveText: {
    color: "#fff",
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
    color: "#EF4444",
    textAlign: "center",
  },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#3B82F6",
  },
  retryText: {
    color: "#fff",
  },
  empty: {
    textAlign: "center",
    opacity: 0.6,
    padding: 24,
  },
});
