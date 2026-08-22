import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "~/lib/auth-context";
import { listMyOrganizations } from "~/lib/team-api";
import { Avatar } from "~/components/avatar";
import { API_BASE_URL } from "~/lib/env";
import { colors } from "~/lib/theme";

/**
 * Settings — profile, workspace selection, and app/runtime info. Log out
 * lives here (moved out of the chat list header).
 */
export default function SettingsScreen() {
  const { user, teamDisplayName, organizationId, logout } = useAuth();

  const orgsQuery = useQuery({
    queryKey: ["me", "organizations"],
    queryFn: ({ signal }) => listMyOrganizations(signal),
  });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionHeader}>Profile</Text>
        <View style={styles.card}>
          <View style={styles.profileRow}>
            {user?.avatarUrl ? (
              <Avatar name={user.displayName} seed={user.id} imageUrl={user.avatarUrl} kind="human" size={48} />
            ) : (
              <Avatar name={user?.displayName ?? "?"} seed={user?.id ?? "anon"} kind="human" size={48} />
            )}
            <View style={styles.profileMain}>
              <Text style={styles.profileName}>{user?.displayName ?? "—"}</Text>
              <Text style={styles.profileMeta}>{user?.username ? `@${user.username}` : ""}</Text>
            </View>
          </View>
        </View>

        <Text style={styles.sectionHeader}>Workspace</Text>
        <View style={styles.card}>
          <Text style={styles.workspaceName}>{teamDisplayName ?? "—"}</Text>
          {orgsQuery.data && orgsQuery.data.length > 1 && (
            <Text style={styles.workspaceMeta}>
              Member of {orgsQuery.data.length} workspaces (switching lands soon)
            </Text>
          )}
          {orgsQuery.isLoading && <ActivityIndicator color={colors.textMuted} />}
        </View>

        <Text style={styles.sectionHeader}>About</Text>
        <View style={styles.card}>
          <Text style={styles.aboutLine}>API · {API_BASE_URL}</Text>
          <Text style={styles.aboutLine}>Experiment channel · dev</Text>
          <Text style={styles.aboutLine}>Dark-locked theme · first-tree.ai palette</Text>
        </View>

        <Pressable
          onPress={() => void logout()}
          style={({ pressed }) => [styles.logoutButton, pressed && styles.pressed]}
        >
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
      </ScrollView>
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
  content: {
    paddingBottom: 32,
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
  card: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
    padding: 14,
    gap: 6,
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  profileMain: {
    flex: 1,
  },
  profileName: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.text,
  },
  profileMeta: {
    color: colors.textMuted,
    fontSize: 13,
  },
  workspaceName: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  workspaceMeta: {
    color: colors.textMuted,
    fontSize: 13,
  },
  aboutLine: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  logoutButton: {
    marginHorizontal: 16,
    marginTop: 24,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.5)",
    alignItems: "center",
    paddingVertical: 12,
  },
  logoutText: {
    color: colors.danger,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.75,
  },
});
