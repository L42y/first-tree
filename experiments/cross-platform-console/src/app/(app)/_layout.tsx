import Ionicons from "@expo/vector-icons/Ionicons";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Redirect } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useMemo } from "react";
import type { ColorValue } from "react-native";
import { ActivityIndicator, Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useTheme } from "tamagui";

import { useAuth } from "~/lib/auth-context";
import { asChatRows } from "~/lib/chat-list-cache";
import { fetchChatRows } from "~/lib/chats-api";
import { loadLiquidGlass } from "~/lib/liquid-glass";
import { useOrgRealtime } from "~/lib/realtime";
import { colors } from "~/lib/theme";

/**
 * Tab icon factory — outline when idle, solid when focused, for the
 * classic (Android/web) tab bar and wide-screen sidebar rail.
 */
const tabIcon =
  (outline: keyof typeof Ionicons.glyphMap, solid: keyof typeof Ionicons.glyphMap) =>
  ({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) => (
    <Ionicons name={focused ? solid : outline} size={size} color={color} />
  );

/**
 * Real UITabBarController-backed tabs on iOS: automatic Liquid Glass,
 * scroll-to-minimize, and (via sidebarAdaptable) the native iPad sidebar
 * split — nothing here has to be hand-rolled the way the classic bar
 * below does. `unstable_` in the import path is Expo's own, not ours.
 */
function IOSNativeTabs({ attentionCount }: { attentionCount: number }) {
  return (
    <NativeTabs
      tintColor={colors.accent}
      iconColor={{ default: colors.textMuted, selected: colors.accent }}
      sidebarAdaptable
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }}
        />
        {attentionCount > 0 && <NativeTabs.Trigger.Badge>{String(attentionCount)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="team">
        <NativeTabs.Trigger.Label>Team</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "person.2", selected: "person.2.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="context">
        <NativeTabs.Trigger.Label>Context</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="arrow.triangle.branch" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="docs">
        <NativeTabs.Trigger.Label>Docs</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "doc.text", selected: "doc.text.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

/**
 * Android/web fallback: expo-router's JS tab bar with a hand-wired glass
 * background (expo-glass-effect isn't reachable there anyway, so this
 * always renders the opaque fallback) plus the wide-screen sidebar rail
 * this app adds on top — NativeTabs' sidebarAdaptable is iOS/macOS-only,
 * so desktop web still needs its own responsive breakpoint.
 */
function ClassicTabs({ attentionCount }: { attentionCount: number }) {
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;
  const liquidGlass = useMemo(loadLiquidGlass, []);
  const GlassView = liquidGlass?.GlassView;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarPosition: isWide ? "left" : "bottom",
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: GlassView ? "transparent" : colors.bg,
          borderTopColor: colors.border,
          ...(isWide ? { borderRightWidth: StyleSheet.hairlineWidth, borderTopWidth: 0 } : { position: "absolute" }),
        },
        tabBarBackground: GlassView
          ? () => <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" colorScheme="dark" />
          : undefined,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chats",
          tabBarBadge: attentionCount || undefined,
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
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings", tabBarIcon: tabIcon("settings-outline", "settings") }}
      />
    </Tabs>
  );
}

export default function AppLayout() {
  const { isAuthenticated, meLoaded } = useAuth();
  useOrgRealtime(meLoaded && isAuthenticated);
  const theme = useTheme();

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
  const attentionCount = (chatsQuery.data ?? []).reduce(
    (total, row) => total + row.unreadMentionCount + (row.openRequestCount > 0 ? 1 : 0),
    0,
  );

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
      {Platform.OS === "ios" ? (
        <IOSNativeTabs attentionCount={attentionCount} />
      ) : (
        <ClassicTabs attentionCount={attentionCount} />
      )}
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
