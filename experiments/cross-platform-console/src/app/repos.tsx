import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { listGitHubRepos } from "~/lib/integrations-api";
import { colors } from "~/lib/theme";

/**
 * Repositories — every repo the GitHub App can access for the signed-in
 * user (`GET /me/github/repos`), with client-side search. Reached from
 * Quick Actions, so it's a root-level push (like chat/agent detail)
 * rather than a tab.
 */
export default function RepositoriesScreen() {
  const router = useRouter();
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["me", "github-repos"],
    queryFn: ({ signal }) => listGitHubRepos(signal),
  });

  const repos = (data?.repos ?? []).filter((repo) => repo.fullName.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton}>
          <Text style={styles.back}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Repositories</Text>
        <Text style={styles.subtitle}>{data?.repos.length ?? 0} accessible via the GitHub App</Text>
      </View>

      <TextInput
        style={styles.search}
        placeholder="Filter repositories…"
        placeholderTextColor={colors.textMuted}
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {isLoading ? (
        <ActivityIndicator style={styles.centerSelf} color={colors.textMuted} />
      ) : error ? (
        <Text style={styles.errorText}>{error instanceof Error ? error.message : "Failed to load repositories"}</Text>
      ) : repos.length === 0 ? (
        <Text style={styles.emptyText}>No repositories match.</Text>
      ) : (
        <View style={styles.list}>
          {repos.map((repo) => (
            <View key={repo.fullName} style={styles.row}>
              <Text style={styles.repoName} numberOfLines={1}>
                {repo.private ? "🔒 " : ""}
                {repo.fullName}
              </Text>
            </View>
          ))}
        </View>
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
  backButton: {
    marginBottom: 8,
  },
  back: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.text,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  search: {
    marginHorizontal: 16,
    marginTop: 12,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  centerSelf: {
    marginTop: 32,
    alignSelf: "center",
  },
  errorText: {
    color: colors.danger,
    textAlign: "center",
    marginTop: 32,
    paddingHorizontal: 24,
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 32,
  },
  list: {
    marginTop: 8,
    paddingBottom: 24,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  repoName: {
    color: colors.text,
    fontSize: 14,
  },
});
