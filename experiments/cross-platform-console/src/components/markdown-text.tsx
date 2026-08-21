import Constants from "expo-constants";
import { StyleSheet, Text, View } from "react-native";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";

import { colors } from "~/lib/theme";

/**
 * Markdown renderer with an Expo Go fallback.
 *
 * react-native-enriched-markdown ships native views (Ratex/C++), which
 * Expo Go cannot host — there the component mounts as an empty view and
 * message bodies disappear. When running inside Expo Go
 * (`appOwnership === "expo"`) we render plain text instead; in a dev
 * client or standalone build the real markdown renderer is used.
 */
const IS_EXPO_GO = Constants.appOwnership === "expo";

export function MarkdownText({ value }: { value: string }) {
  if (IS_EXPO_GO || !value) {
    return <Text style={styles.fallback}>{value}</Text>;
  }
  return (
    <View>
      <EnrichedMarkdownText
        markdown={value}
        containerStyle={styles.container}
        markdownStyle={{ paragraph: { color: colors.text } }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    fontSize: 15,
    color: colors.text,
  },
  container: {},
});
