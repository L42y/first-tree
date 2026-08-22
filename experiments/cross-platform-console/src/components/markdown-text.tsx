import Constants from "expo-constants";
import { StyleSheet, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";

import { colors } from "~/lib/theme";

/**
 * Markdown rendering with two engines:
 *
 *  - Dev client / standalone builds: `EnrichedMarkdownText` — Software
 *    Mansion's native Ratex renderer (fastest, richest).
 *  - Expo Go: a pure-JS renderer (`react-native-markdown-display`). The
 *    native views cannot load in Expo Go, but markdown should still
 *    render formatted there.
 */

const IS_EXPO_GO = Constants.appOwnership === "expo";

const jsTheme = {
  // Every rule gets an explicit light-on-dark color — the library defaults
  // are black-on-white and several rules do not inherit from `body`.
  body: { color: colors.text, fontSize: 15 },
  paragraph: { color: colors.text, fontSize: 15, marginTop: 0, marginBottom: 0 },
  strong: { color: colors.text, fontWeight: "700" as const },
  em: { color: colors.text, fontStyle: "italic" as const },
  del: { color: colors.textMuted },
  heading1: { color: colors.text, fontSize: 20, fontWeight: "700" as const },
  heading2: { color: colors.text, fontSize: 18, fontWeight: "700" as const },
  heading3: { color: colors.text, fontSize: 16, fontWeight: "700" as const },
  heading4: { color: colors.text, fontWeight: "700" as const },
  heading5: { color: colors.text, fontWeight: "700" as const },
  heading6: { color: colors.textSecondary, fontWeight: "700" as const },
  hr: { backgroundColor: colors.border, color: colors.border },
  link: { color: colors.accent, textDecorationLine: "underline" as const },
  blockquote: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    color: colors.textSecondary,
  },
  quote: { color: colors.textSecondary },
  code_inline: {
    color: colors.text,
    backgroundColor: colors.surface,
    fontFamily: "Menlo",
  },
  fence: {
    color: colors.text,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    fontFamily: "Menlo",
  },
  bullet_list: { color: colors.text },
  ordered_list: { color: colors.text },
  list_item: { color: colors.text },
  bullet_list_icon: { color: colors.textMuted },
  ordered_list_icon: { color: colors.textMuted },
  checkbox: { color: colors.text },
  checkbox_icon: { color: colors.textMuted },
  table: { borderColor: colors.border },
  thead: { color: colors.text, backgroundColor: colors.surfaceStrong },
  tbody: { color: colors.text },
  th: { color: colors.text },
  tr: { color: colors.text, borderColor: colors.border },
  td: { color: colors.text },
};

export function MarkdownText({ value }: { value: string }) {
  if (IS_EXPO_GO) {
    return (
      <View>
        <Markdown style={jsTheme}>{value}</Markdown>
      </View>
    );
  }
  return (
    <View>
      <EnrichedMarkdownText
        markdown={value}
        markdownStyle={{ paragraph: { color: colors.text } }}
      />
    </View>
  );
}
