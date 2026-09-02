import { Redirect, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { ChatDetailContent } from "~/components/chat-detail";
import { useAuth } from "~/lib/auth-context";
import { colors } from "~/lib/theme";

/** Route wrapper for the chat detail — the UI lives in ChatDetailContent. */
export default function ChatDetailScreen() {
  const { isAuthenticated, meLoaded } = useAuth();
  const { chatId } = useLocalSearchParams<{ chatId?: string | string[] }>();
  const id = Array.isArray(chatId) ? chatId[0] : chatId;

  if (!meLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (!isAuthenticated) return <Redirect href="/login" />;
  if (!id) return <Redirect href="/(app)" />;

  return <ChatDetailContent chatId={id} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
});
