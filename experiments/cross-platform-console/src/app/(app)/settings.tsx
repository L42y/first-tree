import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "~/lib/auth-context";
import { listMyClients, listMyOrganizations } from "~/lib/team-api";
import { getMyAuthProviders, listGitHubRepos } from "~/lib/integrations-api";
import { Avatar } from "~/components/avatar";
import { API_BASE_URL } from "~/lib/env";
import { colors } from "~/lib/theme";

/**
 * Settings — profile, workspace selection, and app/runtime info. Log out
 * lives here (moved out of the chat list header).
 */
export default function SettingsScreen() {
  const { user, teamDisplayName, organizationId, selectOrganization, logout } = useAuth();
  const queryClient = useQueryClient();

  const switchOrg = async (id: string) => {
    if (id === organizationId) return;
    await selectOrganization(id);
    // Cached queries are org-scoped in spirit — drop them so every surface
    // refetches against the newly active workspace.
    queryClient.clear();
  };

  const orgsQuery = useQuery({
    queryKey: ["me", "organizations"],
    queryFn: ({ signal }) => listMyOrganizations(signal),
  });

  const clientsQuery = useQuery({
    queryKey: ["me", "clients"],
    queryFn: ({ signal }) => listMyClients(signal),
  });

  const authProvidersQuery = useQuery({
    queryKey: ["me", "auth-providers"],
    queryFn: ({ signal }) => getMyAuthProviders(signal),
  });

  const githubReposQuery = useQuery({
    queryKey: ["me", "github-repos"],
    queryFn: ({ signal }) => listGitHubRepos(signal),
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
        <View style={[styles.card, styles.workspaceCard]}>
          {orgsQuery.isLoading && <ActivityIndicator color={colors.textMuted} />}
          {(orgsQuery.data ?? []).map((org) => {
            const active = org.id === organizationId;
            return (
              <Pressable
                key={org.id}
                disabled={active}
                onPress={() => void switchOrg(org.id)}
                style={({ pressed }) => [
                  styles.orgRow,
                  active && styles.orgRowActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.orgName, active && styles.orgNameActive]}>
                  {org.displayName || org.name}
                </Text>
                <Text style={styles.orgMeta}>{active ? "Active" : org.role}</Text>
              </Pressable>
            );
          })}
          {!orgsQuery.isLoading && (orgsQuery.data?.length ?? 0) === 0 && (
            <Text style={styles.workspaceMeta}>No workspaces found.</Text>
          )}
        </View>

        <Text style={styles.sectionHeader}>Computers</Text>
        <View style={[styles.card, styles.workspaceCard]}>
          {clientsQuery.isLoading && <ActivityIndicator color={colors.textMuted} />}
          {(clientsQuery.data ?? []).map((client) => (
            <View key={client.id} style={styles.orgRow}>
              <Text style={styles.orgName}>{client.hostname}</Text>
              <Text style={styles.orgMeta}>
                {client.status}
                {client.os ? ` · ${client.os}` : ""}
                {client.sdkVersion ? ` · v${client.sdkVersion}` : ""}
                {` · ${client.agentCount} agent${client.agentCount === 1 ? "" : "s"}`}
              </Text>
            </View>
          ))}
          {!clientsQuery.isLoading && (clientsQuery.data?.length ?? 0) === 0 && (
            <Text style={styles.workspaceMeta}>No connected computers.</Text>
          )}
        </View>

        <Text style={styles.sectionHeader}>Integrations</Text>
        <View style={[styles.card, styles.workspaceCard]}>
          {(authProvidersQuery.data?.providers ?? []).map((provider) => (
            <View key={provider.provider} style={styles.orgRow}>
              <Text style={styles.orgName}>
                {provider.provider === "google" ? "Google" : "GitHub"} sign-in
              </Text>
              <Text style={styles.orgMeta}>
                {(provider.connected ?? false)
                  ? `Connected${provider.email ? ` · ${provider.email}` : ""}`
                  : "Not connected"}
              </Text>
            </View>
          ))}
          {!authProvidersQuery.isLoading &&
            (authProvidersQuery.data?.providers?.length ?? 0) === 0 && (
              <Text style={styles.workspaceMeta}>Loading sign-in identities…</Text>
            )}
          <View style={[styles.orgRow, styles.orgRowLast]}>
            <Text style={styles.orgName}>GitHub repositories</Text>
            <Text style={styles.orgMeta}>
              {githubReposQuery.isLoading
                ? "…"
                : `${githubReposQuery.data?.items?.length ?? 0} accessible via the App`}
            </Text>
          </View>
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
  workspaceCard: {
    gap: 0,
    padding: 0,
    overflow: "hidden",
  },
  orgRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  orgRowLast: {
    borderBottomWidth: 0,
  },
  orgRowActive: {
    backgroundColor: "rgba(59,130,246,0.12)",
  },
  orgName: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  orgNameActive: {
    color: colors.accent,
  },
  orgMeta: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
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
