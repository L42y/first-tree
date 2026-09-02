import Ionicons from "@expo/vector-icons/Ionicons";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Redirect, Tabs } from "expo-router";
import type { ColorValue } from "react-native";
import { ActivityIndicator, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useTheme } from "tamagui";

import { useAuth } from "~/lib/auth-context";
import { asChatRows } from "~/lib/chat-list-cache";
import { fetchChatRows } from "~/lib/chats-api";
import { useOrgRealtime } from "~/lib/realtime";
import { colors } from "~/lib/theme";

/**
 * Tab icon factory — outline when idle, solid when focused, the platform-native
 * idiom on the phone tab bar and the wide-screen sidebar rail alike.
 */
const tabIcon =
  (outline: keyof typeof Ionicons.glyphMap, solid: keyof typeof Ionicons.glyphMap) =>
  ({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) => (
    <Ionicons name={focused ? solid : outline} size={size} color={color} />
  );

/**
 * Adaptive shell: bottom tab bar on phones, left sidebar rail on
 * tablet/desktop/wide screens (>= 1024pt) — one layout for every surface.
 */
export default function AppLayout() {
  const { isAuthenticated, meLoaded } = useAuth();
  useOrgRealtime(meLoaded && isAuthenticated);
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;

  // Attention badge source for the Chats tab — hooks stay unconditional;
  // fetching is gated on the session instead.
  const chatsQuery = useQuery({
    queryKey: ["me", "chats", "list", "all"],
    queryFn: ({ signal }) => fetchChatRows("all", signal),
    select: asChatRows,
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
          options={{
            title: "Chats",
            tabBarBadge: attentionCount,
            tabBarIcon: tabIcon("chatbubbles-outline", "chatbubbles"),
          }}
        />
        <Tabs.Screen name="team" options={{ title: "Team", tabBarIcon: tabIcon("people-outline", "people") }} />
        <Tabs.Screen
          name="context"
          options={{ title: "Context", tabBarIcon: tabIcon("git-branch-outline", "git-branch") }}
        />
        <Tabs.Screen
          name="docs"
          options={{ title: "Docs", tabBarIcon: tabIcon("document-text-outline", "document-text") }}
        />
        <Tabs.Screen name="attention" options={{ href: null }} />
        <Tabs.Screen name="repos" options={{ href: null }} />
        <Tabs.Screen
          name="settings"
          options={{ title: "Settings", tabBarIcon: tabIcon("settings-outline", "settings") }}
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
