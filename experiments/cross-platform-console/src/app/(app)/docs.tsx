import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import type { DocStatus } from "~/lib/docs-api";
import { getDocBySlug, listDocs } from "~/lib/docs-api";
import { MarkdownText } from "~/components/markdown-text";
import { colors } from "~/lib/theme";

const STATUS_FILTERS: Array<DocStatus | "all"> = ["all", "draft", "in_review", "approved", "archived"];

/**
 * Context → Docs: read-only list of the workspace's review documents
 * (same `/documents` surface as the web console's docs pages). Tap a doc
 * to read its latest version as markdown.
 */
export default function DocsScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;
  const [statusFilter, setStatusFilter] = useState<DocStatus | "all">("all");
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["docs", statusFilter],
    queryFn: ({ signal }) =>
      listDocs({ status: statusFilter === "all" ? undefined : statusFilter, limit: 200 }, signal),
  });

  const docQuery = useQuery({
    queryKey: ["doc", openSlug],
    queryFn: ({ signal }) => getDocBySlug(openSlug!, signal),
    enabled: !!openSlug,
  });

  if (openSlug) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={() => setOpenSlug(null)} hitSlop={8}>
            <Text style={styles.back}>Docs</Text>
          </Pressable>
        </View>
        {docQuery.isLoading ? (
          <ActivityIndicator style={styles.centerSelf} color={colors.textMuted} />
        ) : docQuery.data ? (
          <ScrollView contentContainerStyle={styles.docContent}>
            <Text style={styles.docTitle}>{docQuery.data.doc.title}</Text>
            <MarkdownText value={docQuery.data.content} />
          </ScrollView>
        ) : (
          <Text style={[styles.centerSelf, styles.errorText]}>Document not found.</Text>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Docs</Text>
      </View>

      <View style={styles.filters}>
        {STATUS_FILTERS.map((s) => (
          <Pressable
            key={s}
            onPress={() => setStatusFilter(s)}
            style={[styles.chip, statusFilter === s && styles.chipActive]}
          >
            <Text style={[styles.chipText, statusFilter === s && styles.chipTextActive]}>{s}</Text>
          </Pressable>
        ))}
      </View>

      {listQuery.isLoading ? (
        <ActivityIndicator style={styles.centerSelf} color={colors.textMuted} />
      ) : (listQuery.data?.items.length ?? 0) === 0 ? (
        <Text style={styles.emptyText}>No documents.</Text>
      ) : (
        <ScrollView contentContainerStyle={isWide ? [styles.list, styles.wideList] : styles.list}>
          {(listQuery.data?.items ?? []).map((doc) => (
            <Pressable
              key={doc.id}
              onPress={() => setOpenSlug(doc.slug)}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            >
              <Text style={styles.docRowTitle} numberOfLines={1}>
                {doc.title}
              </Text>
              <Text style={styles.docMeta}>
                {doc.status}
                {doc.project ? ` · ${doc.project}` : ""}
                {` · v${doc.latestVersion}`}
                {doc.openCommentCount > 0 ? ` · ${doc.openCommentCount} comments` : ""}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
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
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.text,
  },
  back: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  filters: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 9999,
    backgroundColor: colors.surface,
  },
  chipActive: {
    backgroundColor: colors.accent,
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  chipTextActive: {
    color: colors.accentText,
  },
  list: {
    paddingBottom: 24,
  },
  wideList: {
    maxWidth: 900,
    width: "100%",
    alignSelf: "center",
    paddingHorizontal: 16,
  },
  card: {
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
    padding: 12,
    gap: 3,
  },
  pressed: {
    opacity: 0.75,
  },
  docRowTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  docMeta: {
    color: colors.textMuted,
    fontSize: 12,
  },
  centerSelf: {
    marginTop: 32,
    alignSelf: "center",
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 32,
  },
  docContent: {
    padding: 16,
    paddingBottom: 40,
    gap: 8,
  },
  docTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 8,
  },
  errorText: {
    color: colors.danger,
  },
});
