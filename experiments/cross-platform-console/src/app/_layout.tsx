import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { TamaguiProvider, Theme } from "tamagui";
import { TeamSwitchOverlay } from "~/components/team-switcher";
import { AuthProvider } from "~/lib/auth-context";
import { queryClient } from "~/lib/query-client";
import { colors } from "~/lib/theme";
import { config } from "~/tamagui.config";

export default function RootLayout() {
  // The experiment ships dark-first, matching first-tree.ai's near-black
  // brand canvas. System-scheme follow-up can revisit this later.
  const themeName = "dark";
  const pathname = usePathname();

  useFonts({
    Inter: require("@tamagui/font-inter/otf/Inter-Medium.otf"),
    InterBold: require("@tamagui/font-inter/otf/Inter-Bold.otf"),
  });

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(themeName === "dark" ? "#07151F" : "#E6F4FE").catch(() => {
      // Ignore environments where the system UI API is unavailable.
    });
  }, []);

  useEffect(() => {
    // TODO: wire up PostHog screen tracking here once analytics is integrated.
    // eslint-disable-next-line no-console
    console.log("[screen]", pathname);
  }, [pathname]);

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <TamaguiProvider config={config} defaultTheme={themeName}>
          <Theme name={themeName}>
            <AuthProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="login" />
                <Stack.Screen name="(app)" />
                <Stack.Screen
                  name="chat/[chatId]"
                  options={{
                    headerShown: false,
                    contentStyle: { backgroundColor: colors.bg },
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                  }}
                />
                <Stack.Screen
                  name="agent/[uuid]"
                  options={{
                    headerShown: false,
                    contentStyle: { backgroundColor: colors.bg },
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                  }}
                />
                <Stack.Screen
                  name="agent/new"
                  options={{
                    headerShown: false,
                    contentStyle: { backgroundColor: colors.bg },
                    gestureEnabled: true,
                  }}
                />
                <Stack.Screen
                  name="attention"
                  options={{
                    headerShown: false,
                    contentStyle: { backgroundColor: colors.bg },
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                  }}
                />
                <Stack.Screen
                  name="repos"
                  options={{
                    headerShown: false,
                    contentStyle: { backgroundColor: colors.bg },
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                  }}
                />
                <Stack.Screen
                  name="ask/[requestId]"
                  options={{
                    // The sheet draws its own container, so the route only has
                    // to be a transparent full-height surface for it to cap
                    // itself against.
                    presentation: "transparentModal",
                    animation: "fade",
                    headerShown: false,
                    contentStyle: { backgroundColor: "transparent" },
                    gestureEnabled: true,
                  }}
                />
              </Stack>
              <TeamSwitchOverlay />
              <StatusBar style={themeName === "dark" ? "light" : "dark"} />
            </AuthProvider>
          </Theme>
        </TamaguiProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
