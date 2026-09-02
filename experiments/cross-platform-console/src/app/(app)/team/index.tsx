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

  // The list must be the screen's sole/first native child (react-native-screens
  // walks subview[0] down from the screen root to find the scroll view it
  // ties the large-title collapse animation to), so the subtitle/loading/error
  // states that used to sit above it as siblings now ride inside via
  // ListHeaderComponent/ListEmptyComponent instead.
  const listEmpty = isLoading ? (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.textMuted} />
    </View>
  ) : error ? (
    <View style={styles.center}>
      <Text style={styles.errorText}>{error instanceof Error ? error.message : "Failed to load team"}</Text>
    </View>
  ) : null;

  const listPane = (
    <View style={[styles.container, styles.teamPane]}>
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
        ListHeaderComponent={<Text style={styles.subtitle}>{(data ?? []).length} agents you manage</Text>}
        ListEmptyComponent={listEmpty}
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
  subtitle: {
    color: colors.textSecondary,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  pressed: {
    opacity: 0.75,
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
