import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Redirect, Tabs } from "expo-router";
import { useTheme } from "tamagui";
import { useWindowDimensions } from "react-native";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useAuth } from "~/lib/auth-context";
import { fetchChatRows } from "~/lib/chats-api";
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

  // Attention badge source for the Chats tab — hooks stay unconditional;
  // fetching is gated on the session instead.
  const chatsQuery = useQuery({
    queryKey: ["me", "chats", "list", "all"],
    queryFn: ({ signal }) => fetchChatRows("all", signal),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    enabled: meLoaded && isAuthenticated,
  });
  const attentionCount =
    (chatsQuery.data ?? []).reduce(
      (total, row) => total + row.unreadMentionCount + (row.openRequestCount > 0 ? 1 : 0),
      0,
    ) || undefined;

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
          options={{ title: "Chats", tabBarBadge: attentionCount }}
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
          name="docs"
          options={{ title: "Docs" }}
        />
        <Tabs.Screen
          name="agent/new"
          options={{ href: null, tabBarButton: () => null }}
        />
        <Tabs.Screen
          name="agent/[uuid]"
          options={{ href: null, tabBarButton: () => null }}
        />
        <Tabs.Screen
          name="attention"
          options={{ href: null, tabBarButton: () => null }}
        />
        <Tabs.Screen
          name="repos"
          options={{ href: null, tabBarButton: () => null }}
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
          name="agent/new"
          options={{ href: null, tabBarButton: () => null }}
        />
        <Tabs.Screen
          name="agent/[uuid]"
          options={{ href: null, tabBarButton: () => null }}
        />
        <Tabs.Screen
          name="attention"
          options={{ href: null, tabBarButton: () => null }}
        />
        <Tabs.Screen
          name="repos"
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
