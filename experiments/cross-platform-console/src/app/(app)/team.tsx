import { useMemo } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Pressable, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";

import type { ManagedAgent } from "~/lib/team-api";
import { listManagedAgents } from "~/lib/team-api";
import { Avatar } from "~/components/avatar";
import { colors } from "~/lib/theme";

/**
 * Team — every agent the signed-in user manages across organizations
 * (same source as the web console's Team roster).
 */
export default function TeamScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const numColumns = width >= 1024 ? 2 : 1;

  const { data, isLoading, error, refetch } = useQuery({
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

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Team</Text>
        <Text style={styles.subtitle}>{(data ?? []).length} agents you manage</Text>
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
          contentContainerStyle={[styles.listContent, numColumns > 1 && styles.widePadding]}
          renderItem={({ item }) => (
            <View>
              <Text style={styles.sectionHeader}>{item.organizationId}</Text>
              {item.agents.map((agent) => (
                <Pressable
                  key={agent.uuid}
                  onPress={() => router.push(`/agent/${agent.uuid}`)}
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
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
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
  widePadding: {
    paddingHorizontal: 24,
    maxWidth: 900,
    width: "100%",
    alignSelf: "center",
  },
  listContent: {
    paddingBottom: 24,
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
