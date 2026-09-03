import type { Agent } from "@first-tree/shared";
import { agentSchema } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Avatar } from "~/components/avatar";
import { api, withOrg } from "~/lib/api";
import { createTaskChat } from "~/lib/chats-api";
import { listMyClients, updateAgent } from "~/lib/team-api";
import { colors } from "~/lib/theme";

/**
 * Agent detail — read-only facts over `GET /agents/:uuid` plus management
 * actions mirroring the web console's agent controls: suspend/reactivate
 * and runtime switching to one of your connected computers.
 */
export function AgentDetailContent({
  uuid,
  provider,
  showBack = true,
}: {
  uuid: string;
  provider?: string;
  /** Hidden when embedded in a two-pane layout. */
  showBack?: boolean;
}) {
  const queryClient = useQueryClient();
  const [acting, setActing] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [startingChat, setStartingChat] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [editVisibility, setEditVisibility] = useState<"private" | "organization" | null>(null);

  const { data, isLoading, error } = useQuery<Agent>({
    queryKey: ["agent", uuid],
    queryFn: async () => agentSchema.parse(await api.get<unknown>(withOrg(`/agents/${encodeURIComponent(uuid)}`))),
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

  const saveEdit = async () => {
    if (!data) return;
    const body: Record<string, unknown> = {};
    const name = editName?.trim();
    if (name && name !== data.displayName) body.displayName = name;
    if (editVisibility && editVisibility !== data.visibility) body.visibility = editVisibility;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    setActing(true);
    try {
      await updateAgent(uuid, body);
      await queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
      await queryClient.invalidateQueries({ queryKey: ["me", "managed-agents"] });
      setEditing(false);
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
  const runtimeProvider = provider ?? (data as unknown as { runtimeProvider?: string }).runtimeProvider ?? "unknown";

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
        {showBack && (
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        )}
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
        {!isHuman && (
          <Pressable
            disabled={acting}
            onPress={() => {
              setEditName(data.displayName);
              setEditVisibility(data.visibility === "private" ? "private" : "organization");
              setEditing((v) => !v);
            }}
            hitSlop={8}
            style={({ pressed }) => [styles.editButton, pressed && styles.pressed, acting && styles.disabled]}
          >
            <Text style={styles.editButtonText}>{editing ? "Cancel" : "Edit"}</Text>
          </Pressable>
        )}
      </View>

      {editing ? (
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Display name</Text>
          <TextInput
            style={styles.input}
            value={editName ?? ""}
            onChangeText={setEditName}
            placeholder="Display name"
            placeholderTextColor={colors.textMuted}
          />
          <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Visibility</Text>
          <View style={styles.segmentRow}>
            {(["organization", "private"] as const).map((option) => (
              <Pressable
                key={option}
                onPress={() => setEditVisibility(option)}
                style={[styles.segment, (editVisibility ?? data.visibility) === option && styles.segmentActive]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    (editVisibility ?? data.visibility) === option && styles.segmentTextActive,
                  ]}
                >
                  {option === "organization" ? "Workspace" : "Private"}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            disabled={acting}
            onPress={() => void saveEdit()}
            style={({ pressed }) => [styles.saveButton, acting && styles.disabled, pressed && styles.pressed]}
          >
            {acting ? (
              <ActivityIndicator size="small" color={colors.accentText} />
            ) : (
              <Text style={styles.saveText}>Save changes</Text>
            )}
          </Pressable>
        </View>
      ) : (
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
      )}

      {!isHuman && (
        <>
          <Text style={styles.sectionHeader}>Start chat</Text>
          <View style={styles.card}>
            <TextInput
              style={styles.chatInput}
              placeholder={`Message ${data.displayName}…`}
              placeholderTextColor={colors.textMuted}
              value={chatDraft}
              onChangeText={setChatDraft}
              multiline
            />
            <Pressable
              disabled={startingChat || !chatDraft.trim()}
              onPress={async () => {
                setStartingChat(true);
                try {
                  const created = await createTaskChat(data.uuid, chatDraft.trim());
                  setChatDraft("");
                  router.replace(`/chat/${created.chatId}`);
                } finally {
                  setStartingChat(false);
                }
              }}
              style={({ pressed }) => [
                styles.startButton,
                (startingChat || !chatDraft.trim()) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {startingChat ? (
                <ActivityIndicator size="small" color={colors.accentText} />
              ) : (
                <Text style={styles.startButtonText}>Start chat</Text>
              )}
            </Pressable>
          </View>

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
  backButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.surfaceStrong,
    marginRight: 8,
  },
  backText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
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
  editButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.surfaceStrong,
  },
  editButtonText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700",
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
    marginBottom: 6,
  },
  fieldLabelSpaced: {
    marginTop: 12,
  },
  input: {
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  segmentRow: {
    flexDirection: "row",
    gap: 8,
  },
  segment: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    paddingVertical: 9,
  },
  segmentActive: {
    borderColor: colors.accent,
    backgroundColor: "rgba(59,130,246,0.15)",
  },
  segmentText: {
    color: colors.textSecondary,
    fontWeight: "600",
    fontSize: 13,
  },
  segmentTextActive: {
    color: colors.accentText,
  },
  saveButton: {
    marginTop: 14,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: "center",
    paddingVertical: 11,
  },
  saveText: {
    color: colors.accentText,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.75,
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
  chatInput: {
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  startButton: {
    marginTop: 8,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: "center",
    paddingVertical: 11,
  },
  startButtonText: {
    color: colors.accentText,
    fontWeight: "700",
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
});
