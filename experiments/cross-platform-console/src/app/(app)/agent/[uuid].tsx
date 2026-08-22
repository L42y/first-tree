import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import type { Agent } from "@first-tree/shared";
import { agentSchema } from "@first-tree/shared";

import { Avatar } from "~/components/avatar";
import { api, withOrg } from "~/lib/api";
import { colors } from "~/lib/theme";

/**
 * Agent detail — read-only view over `GET /agents/:uuid` (the web console's
 * agent page data source). Editing surfaces come later.
 */
export default function AgentDetailScreen() {
  const { uuid } = useLocalSearchParams<{ uuid: string }>();

  const { data, isLoading, error } = useQuery<Agent>({
    queryKey: ["agent", uuid],
    queryFn: async () => agentSchema.parse(await api.get<unknown>(withOrg(`/agents/${encodeURIComponent(uuid)}`))),
  });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.textMuted} />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error instanceof Error ? error.message : "Agent not found"}</Text>
      </View>
    );
  }

  const isHuman = data.type === "human";
  const facts: Array<[string, string | null]> = [
    ["Type", isHuman ? "Human" : "Agent"],
    ["Status", data.status],
    ["Runtime", (data as unknown as { runtimeProvider?: string }).runtimeProvider ?? null],
    ["Visibility", data.visibility],
    ["Handle", data.name],
  ];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Avatar
          name={data.displayName}
          seed={data.uuid}
          imageUrl={(data as unknown as { avatarImageUrl?: string }).avatarImageUrl ?? null}
          kind={isHuman ? "human" : "agent"}
          size={72}
        />
        <View style={styles.heroMain}>
          <Text style={styles.displayName}>{data.displayName}</Text>
          <Text style={styles.handle}>{data.name ? `@${data.name}` : ""}</Text>
        </View>
      </View>

      <View style={styles.card}>
        {facts.map(([label, value]) =>
          value ? (
            <View key={label} style={styles.factRow}>
              <Text style={styles.factLabel}>{label}</Text>
              <Text style={styles.factValue}>{value}</Text>
            </View>
          ) : null,
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingBottom: 32,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  errorText: {
    color: colors.danger,
  },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  heroMain: {
    flex: 1,
  },
  displayName: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
  },
  handle: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  card: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
  },
  factRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  factLabel: {
    color: colors.textMuted,
    fontSize: 13,
  },
  factValue: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
    maxWidth: "60%",
    textAlign: "right",
  },
});
