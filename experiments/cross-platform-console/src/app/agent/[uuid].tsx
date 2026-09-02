import { Redirect, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { AgentDetailContent } from "~/components/agent-detail";
import { useAuth } from "~/lib/auth-context";
import { colors } from "~/lib/theme";

/** Route wrapper — the UI lives in AgentDetailContent. */
export default function AgentDetailScreen() {
  const { isAuthenticated, meLoaded } = useAuth();
  const params = useLocalSearchParams<{ uuid?: string | string[]; provider?: string | string[] }>();
  const uuid = Array.isArray(params.uuid) ? params.uuid[0] : params.uuid;
  const provider = Array.isArray(params.provider) ? params.provider[0] : params.provider;

  if (!meLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (!isAuthenticated) return <Redirect href="/login" />;
  if (!uuid) return <Redirect href="/(app)" />;

  return <AgentDetailContent uuid={uuid} provider={provider} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
});
