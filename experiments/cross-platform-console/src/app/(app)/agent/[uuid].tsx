import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Agent } from "@first-tree/shared";
import { agentSchema } from "@first-tree/shared";

import { Avatar } from "~/components/avatar";
import { api, withOrg } from "~/lib/api";
import { listMyClients } from "~/lib/team-api";
import { colors } from "~/lib/theme";

/**
 * Agent detail — read-only facts over `GET /agents/:uuid` plus management
 * actions mirroring the web console's agent controls: suspend/reactivate
 * and runtime switching to one of your connected computers.
 */
export default function AgentDetailScreen() {
  const { uuid, provider } = useLocalSearchParams<{ uuid: string; provider?: string }>();
  const queryClient = useQueryClient();
  const [acting, setActing] = useState(false);

  const { data, isLoading, error } = useQuery<Agent>({
    queryKey: ["agent", uuid],
    queryFn: async () =>
      agentSchema.parse(await api.get<unknown>(withOrg(`/agents/${encodeURIComponent(uuid)}`))),
  });

  const isHuman = data?.type === "human";

  const clientsQuery = useQuery({
    queryKey: ["me", "clients"],
    queryFn: ({ signal }) => listMyClients(signal),
    enabled: !isHuman && !!data,
  });

  const postAction = async (path: string, body?: unknown) => {
    setActing(true);
    try {
      await api.post(withOrg(`/agents/${encodeURIComponent(uuid)}${path}`), body ?? {});
      await queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
      await queryClient.invalidateQueries({ queryKey: ["me", "managed-agents"] });
    } finally {
      setActing(false);
    }
  };

  const confirmSwitchRuntime = (clientId: string, hostname: string) => {
    Alert.alert(
      "Switch runtime",
      `Move ${data?.displayName ?? "this agent"} to ${hostname}? Active sessions end and local runtime state may not carry over.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Switch",
          style: "destructive",
          onPress: () => {
            const runtimeProvider = provider ?? (data as unknown as { runtimeProvider?: string })?.runtimeProvider;
            if (!runtimeProvider) return;
            void postAction("/switch-runtime", { clientId, runtimeProvider, confirmed: true });
          },
        },
      ],
    );
  };

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

  const suspended = data.status === "suspended";
  const clients = clientsQuery.data ?? [];
  const runtimeProvider =
    provider ?? (data as unknown as { runtimeProvider?: string }).runtimeProvider ?? "unknown";

  const facts: Array<[string, string | null]> = [
    ["Type", isHuman ? "Human" : "Agent"],
    ["Status", data.status],
    ["Runtime", runtimeProvider],
    ["Visibility", data.visibility],
    ["Handle", data.name ?? null],
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

      {!isHuman && (
        <>
          <Text style={styles.sectionHeader}>Actions</Text>
          <View style={styles.card}>
            <Pressable
              onPress={() =>
                Alert.alert(
                  suspended ? "Reactivate agent" : "Suspend agent",
                  suspended
                    ? `Bring ${data.displayName} back online?`
                    : `Suspend ${data.displayName}? Its sessions will stop.`,
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: suspended ? "Reactivate" : "Suspend",
                      style: "destructive",
                      onPress: () => void postAction(suspended ? "/reactivate" : "/suspend"),
                    },
                  ],
                )
              }
              style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
              disabled={acting}
            >
              <Text style={[styles.actionText, { color: colors.danger }]}>
                {suspended ? "Reactivate agent" : "Suspend agent"}
              </Text>
            </Pressable>
          </View>

          <Text style={styles.sectionHeader}>Switch runtime</Text>
          <View style={styles.card}>
            {clientsQuery.isLoading && <ActivityIndicator color={colors.textMuted} />}
            {clients.map((client) => (
              <Pressable
                key={client.id}
                disabled={acting}
                onPress={() => confirmSwitchRuntime(client.id, client.hostname)}
                style={({ pressed }) => [styles.clientRow, pressed && styles.pressed]}
              >
                <View style={styles.clientMain}>
                  <Text style={styles.clientName}>{client.hostname}</Text>
                  <Text style={styles.clientMeta}>
                    {client.status} · {client.agentCount} agents
                  </Text>
                </View>
                <Text style={styles.switchLabel}>Move here</Text>
              </Pressable>
            ))}
            {!clientsQuery.isLoading && clients.length === 0 && (
              <Text style={styles.clientMeta}>No connected computers available.</Text>
            )}
          </View>
        </>
      )}

      {acting && <ActivityIndicator style={styles.actingSpinner} color={colors.accent} />}
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
  sectionHeader: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 8,
  },
  actionButton: {
    paddingVertical: 12,
    alignItems: "center",
  },
  actionText: {
    fontWeight: "700",
    fontSize: 14,
  },
  clientRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 10,
  },
  clientMain: {
    flex: 1,
  },
  clientName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  clientMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  switchLabel: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700",
  },
  actingSpinner: {
    marginTop: 16,
    alignSelf: "center",
  },
  pressed: {
    opacity: 0.75,
  },
});
