import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput } from "react-native";
import { useAuth } from "~/lib/auth-context";
import { fetchChatRows } from "~/lib/chats-api";
import { listDocs } from "~/lib/docs-api";
import { listManagedAgents } from "~/lib/team-api";
import { colors } from "~/lib/theme";

type Item = {
  key: string;
  section: string;
  label: string;
  sub?: string;
  action: () => void;
};

/**
 * Command palette — searchable navigation + session actions plus agents,
 * chats, and docs pulled from warm React Query caches.
 */
export function QuickActions({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const { logout } = useAuth();
  const [search, setSearch] = useState("");

  const agentsQuery = useQuery({
    queryKey: ["me", "managed-agents"],
    queryFn: ({ signal }) => listManagedAgents(signal),
    enabled: visible,
  });
  const chatsQuery = useQuery({
    queryKey: ["me", "chats", "list", "all"],
    queryFn: ({ signal }) => fetchChatRows("all", signal),
    enabled: visible,
  });
  const docsQuery = useQuery({
    queryKey: ["docs", "all"],
    queryFn: ({ signal }) => listDocs({ limit: 50 }, signal),
    enabled: visible,
  });

  const go = (path: string) => {
    onClose();
    router.push(path as never);
  };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [
      { key: "c-attention", section: "Actions", label: "Needs you (asks + unread)", action: () => go("/attention") },
      { key: "c-newchat", section: "Actions", label: "Start chat with an agent…", action: () => go("/team") },
      { key: "c-archived", section: "Actions", label: "Archived chats", action: () => go("/") },
      { key: "c-repos", section: "Actions", label: "Repositories", action: () => go("/repos") },
      { key: "c-docs", section: "Actions", label: "Docs", action: () => go("/docs") },
      { key: "c-context", section: "Actions", label: "Context", action: () => go("/context") },
      { key: "c-team", section: "Actions", label: "Team", action: () => go("/team") },
      { key: "c-settings", section: "Actions", label: "Settings", action: () => go("/settings") },
      { key: "c-logout", section: "Session", label: "Log out", action: () => void logout() },
    ];
    for (const agent of agentsQuery.data ?? []) {
      if (agent.type === "human") continue;
      out.push({
        key: `a-${agent.uuid}`,
        section: "Agents",
        label: agent.displayName,
        sub: agent.type,
        action: () => go(`/agent/${agent.uuid}`),
      });
    }
    for (const chat of chatsQuery.data ?? []) {
      out.push({
        key: `h-${chat.chatId}`,
        section: "Chats",
        label: chat.title,
        sub: chat.lastMessagePreview ?? undefined,
        action: () => go(`/chat/${chat.chatId}`),
      });
    }
    for (const doc of docsQuery.data?.items ?? []) {
      out.push({
        key: `d-${doc.id}`,
        section: "Docs",
        label: doc.title,
        sub: doc.project ?? undefined,
        action: () => go("/docs"),
      });
    }
    return out;
  }, [agentsQuery.data, chatsQuery.data, docsQuery.data, logout]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => `${item.section} ${item.label} ${item.sub ?? ""}`.toLowerCase().includes(needle));
  }, [items, search]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.sheet}>
          <Text style={styles.title}>Command palette</Text>
          <TextInput
            style={styles.search}
            placeholder="Search actions, agents, chats, docs…"
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.key}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  onClose();
                  setSearch("");
                  item.action();
                }}
                style={({ pressed }) => [styles.item, pressed && styles.pressed]}
              >
                <Text style={styles.itemLabel} numberOfLines={1}>
                  {item.label}
                </Text>
                {item.sub ? (
                  <Text style={styles.itemSub} numberOfLines={1}>
                    {item.sub}
                  </Text>
                ) : null}
              </Pressable>
            )}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Self-contained header trigger for the command palette — owns its own
 * open/close state so it can be dropped straight into headerRight (see
 * (app)/index/_layout.tsx) without threading state through the screen.
 */
export function QuickActionsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={8} style={styles.quickButton}>
        <Text style={styles.quickButtonText}>Quick</Text>
      </Pressable>
      <QuickActions visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  quickButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.accent,
  },
  quickButtonText: {
    color: colors.accentText,
    fontWeight: "700",
    fontSize: 12,
  },
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    width: "100%",
    maxWidth: 480,
    height: "70%",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: 12,
  },
  title: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
    paddingBottom: 8,
  },
  search: {
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 15,
    marginBottom: 8,
  },
  list: {
    flex: 1,
  },
  item: {
    paddingHorizontal: 10,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 2,
  },
  pressed: {
    backgroundColor: colors.surface,
  },
  itemLabel: {
    color: colors.text,
    fontSize: 15,
  },
  itemSub: {
    color: colors.textMuted,
    fontSize: 12,
  },
});
