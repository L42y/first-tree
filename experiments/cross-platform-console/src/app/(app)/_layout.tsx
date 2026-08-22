import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Redirect, Tabs } from "expo-router";
import { useTheme } from "tamagui";
import { useWindowDimensions } from "react-native";

import { useAuth } from "~/lib/auth-context";
import { colors } from "~/lib/theme";

/**
 * Adaptive shell: bottom tab bar on phones, left sidebar rail on
 * tablet/desktop/wide screens (>= 1024pt) — one layout for every surface.
 */
export default function AppLayout() {
  const { isAuthenticated, meLoaded } = useAuth();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;

  if (!meLoaded) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background?.val }]}>
        <ActivityIndicator size="large" color={theme.color?.val} />
      </View>
    );
  }

  if (!isAuthenticated) {
    return <Redirect href="/login" />;
  }

  return (
    <View style={styles.root}>
      <Text style={styles.srOnly}>First Tree</Text>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarPosition: isWide ? "left" : "bottom",
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: {
            backgroundColor: colors.bg,
            borderTopColor: colors.border,
            ...(isWide ? { borderRightWidth: StyleSheet.hairlineWidth, borderTopWidth: 0 } : {}),
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{ title: "Chats" }}
        />
        <Tabs.Screen
          name="team"
          options={{ title: "Team" }}
        />
        <Tabs.Screen
          name="context"
          options={{ title: "Context" }}
        />
        <Tabs.Screen
          name="settings"
          options={{ title: "Settings" }}
        />
        <Tabs.Screen
          name="chat/[chatId]"
          options={{ href: null, tabBarButton: () => null }}
        />
        <Tabs.Screen
          name="agent/[uuid]"
          options={{ href: null, tabBarButton: () => null }}
        />
      </Tabs>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  srOnly: {
    display: "none",
  },
});
