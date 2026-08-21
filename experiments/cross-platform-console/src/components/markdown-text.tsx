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
  body: { color: colors.text },
  strong: { color: colors.text },
  em: { color: colors.text },
  heading1: { color: colors.text, fontSize: 20, fontWeight: "700" as const },
  heading2: { color: colors.text, fontSize: 18, fontWeight: "700" as const },
  heading3: { color: colors.text, fontSize: 16, fontWeight: "700" as const },
  heading4: { color: colors.text },
  heading5: { color: colors.text },
  heading6: { color: colors.textMuted },
  hr: { backgroundColor: colors.border },
  bullet_list_icon: { color: colors.textMuted },
  ordered_list_icon: { color: colors.textMuted },
  link: { color: colors.accent, textDecorationLine: "underline" as const },
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
  blockquote: {
    color: colors.textSecondary,
    backgroundColor: colors.surface,
    borderLeftColor: colors.accent,
  },
  quote: { color: colors.textSecondary },
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
