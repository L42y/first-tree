import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { AgentDetailContent } from "~/components/agent-detail";
import { Avatar } from "~/components/avatar";
import { useTabBarFloatingInset } from "~/lib/tab-bar-inset";
import type { ManagedAgent } from "~/lib/team-api";
import { listManagedAgents } from "~/lib/team-api";
import { colors } from "~/lib/theme";

const LIST_BOTTOM_PADDING = 24;

/**
 * Team — every agent the signed-in user manages across organizations
 * (same source as the web console's Team roster).
 */
export default function TeamScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;
  const tabBarInset = useTabBarFloatingInset();
  const [selected, setSelected] = useState<{ uuid: string; provider?: string } | null>(null);
  const numColumns = width >= 1024 ? 2 : 1;

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["me", "managed-agents"],
    queryFn: ({ signal }) => listManagedAgents(signal),
  });

  const grouped = useMemo(() => {
    const rows = data ?? [];
    const byOrg = new Map<string, ManagedAgent[]>();
    for (const row of rows) {
      const list = byOrg.get(row.organizationId) ?? [];
      list.push(row);
      byOrg.set(row.organizationId, list);
    }
    return [...byOrg.entries()].map(([organizationId, agents]) => ({
      organizationId,
      agents,
    }));
  }, [data]);

  const listPane = (
    <View style={[styles.container, styles.teamPane]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Team</Text>
          <Text style={styles.subtitle}>{(data ?? []).length} agents you manage</Text>
        </View>
        <Pressable
          onPress={() => router.push("/agent/new")}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
        >
          <Text style={styles.addButtonText}>+ New</Text>
        </Pressable>
      </View>

      {isLoading && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.textMuted} />
        </View>
      )}

      {error && !isLoading && (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error instanceof Error ? error.message : "Failed to load team"}</Text>
        </View>
      )}

      {!isLoading && !error && (
        <FlatList
          data={grouped}
          keyExtractor={(g) => g.organizationId}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.textMuted} />
          }
          contentContainerStyle={[
            styles.listContent,
            numColumns > 1 && styles.widePadding,
            { paddingBottom: LIST_BOTTOM_PADDING + tabBarInset },
          ]}
          renderItem={({ item }) => (
            <View>
              <Text style={styles.sectionHeader}>{item.organizationId}</Text>
              {item.agents.map((agent) => (
                <Pressable
                  key={agent.uuid}
                  onPress={() => {
                    if (isWide) {
                      setSelected({ uuid: agent.uuid, provider: agent.runtimeProvider ?? "" });
                      return;
                    }
                    router.push({
                      pathname: `/agent/${agent.uuid}`,
                      params: { provider: agent.runtimeProvider ?? "" },
                    } as never);
                  }}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <Avatar
                    name={agent.displayName}
                    seed={agent.uuid}
                    imageUrl={agent.avatarImageUrl}
                    kind={agent.type === "human" ? "human" : "agent"}
                    size={44}
                  />
                  <View style={styles.rowMain}>
                    <Text style={styles.agentName} numberOfLines={1}>
                      {agent.displayName}
                    </Text>
                    <Text style={styles.agentMeta} numberOfLines={1}>
                      {agent.runtimeProvider ?? agent.type} · {agent.status}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}
        />
      )}
    </View>
  );

  if (isWide) {
    return (
      <View style={styles.twoPane}>
        {listPane}
        <View style={styles.detailPane}>
          {selected ? (
            <AgentDetailContent uuid={selected.uuid} provider={selected.provider} showBack={false} />
          ) : (
            <View style={styles.emptyPane}>
              <Text style={styles.emptyPaneText}>Select an agent</Text>
            </View>
          )}
        </View>
      </View>
    );
  }
  return listPane;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  teamPane: {
    maxWidth: 440,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
  },
  twoPane: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: colors.bg,
  },
  detailPane: {
    flex: 1,
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
    marginTop: 2,
  },
  pressed: {
    opacity: 0.75,
  },
  addButton: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: colors.accent,
  },
  addButtonText: {
    color: colors.accentText,
    fontWeight: "700",
    fontSize: 13,
  },
  widePadding: {
    paddingHorizontal: 24,
    maxWidth: 900,
    width: "100%",
    alignSelf: "center",
  },
  listContent: {
    paddingBottom: LIST_BOTTOM_PADDING,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: {
    opacity: 0.7,
    backgroundColor: colors.surface,
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  agentName: {
    fontSize: 15,
    color: colors.text,
    fontWeight: "600",
  },
  agentMeta: {
    fontSize: 12,
    color: colors.textMuted,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    color: colors.danger,
    textAlign: "center",
    paddingHorizontal: 24,
  },
});
