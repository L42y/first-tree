import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import type { Message } from "@first-tree/shared";
import { MarkdownText } from "~/components/markdown-text";
import { colors } from "~/lib/theme";

/**
 * Renderer for `format="card"` messages — rich link cards (e.g. GitHub
 * issue/PR comments) whose `content` is an object ({url, body, …}) rather
 * than plain text. Shows the card body as markdown plus a tappable URL
 * chip, instead of the blank bubbles object content used to produce.
 */
export function MessageCard({ message }: { message: Message }) {
  const content = (typeof message.content === "object" && message.content !== null
    ? message.content
    : {}) as { url?: string; body?: string; title?: string };

  const url = typeof content.url === "string" ? content.url : null;
  const body = typeof content.body === "string" ? content.body : "";

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        {body ? <MarkdownText value={body} /> : null}
        {url && (
          <Pressable onPress={() => void Linking.openURL(url)} style={({ pressed }) => [styles.linkChip, pressed && { opacity: 0.75 }]}>
            <Text style={styles.linkText} numberOfLines={1}>
              {url}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  card: {
    flex: 1,
    maxWidth: "92%",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
    padding: 12,
    gap: 8,
  },
  linkChip: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  linkText: {
    color: colors.accent,
    fontSize: 13,
    textDecorationLine: "underline",
  },
});
