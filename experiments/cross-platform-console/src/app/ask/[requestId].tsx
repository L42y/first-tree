import { Redirect, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { AskThreadScreen } from "~/components/ask-thread";
import { useAuth } from "~/lib/auth-context";
import { colors } from "~/lib/theme";

function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export default function AskModalRoute() {
  const params = useLocalSearchParams<{
    chatId?: string | string[];
    requestId?: string | string[];
  }>();
  const { isAuthenticated, meLoaded } = useAuth();
  const chatId = firstParam(params.chatId);
  const requestId = firstParam(params.requestId);

  if (!meLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!isAuthenticated) return <Redirect href="/login" />;
  if (!chatId || !requestId) return <Redirect href="/(app)" />;

  return <AskThreadScreen key={requestId} chatId={chatId} requestId={requestId} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.62)",
  },
});
