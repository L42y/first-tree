import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect, Stack } from "expo-router";
import { useTheme } from "tamagui";

import { useAuth } from "~/lib/auth-context";

export default function AppLayout() {
  const { isAuthenticated, meLoaded } = useAuth();
  const theme = useTheme();

  useEffect(() => {
    // Nothing to set up yet; reserved for future org-scoped websocket init.
  }, []);

  if (!meLoaded) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background?.val }]}
      >
        <ActivityIndicator size="large" color={theme.color?.val} />
      </View>
    );
  }

  if (!isAuthenticated) {
    return <Redirect href="/login" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="chat/[chatId]" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
