import { useEffect } from "react";
import { useColorScheme } from "react-native";
import { useFonts } from "expo-font";
import { Stack, usePathname } from "expo-router";
import * as SystemUI from "expo-system-ui";
import { StatusBar } from "expo-status-bar";
import { TamaguiProvider, Theme } from "tamagui";

import { config } from "~/tamagui.config";

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const themeName = colorScheme === "dark" ? "dark" : "light";
  const pathname = usePathname();

  useFonts({
    Inter: require("@tamagui/font-inter/otf/Inter-Medium.otf"),
    InterBold: require("@tamagui/font-inter/otf/Inter-Bold.otf"),
  });

  useEffect(() => {
    // Keep the native system UI chrome aligned with the active theme.
    SystemUI.setBackgroundColorAsync(
      themeName === "dark" ? "#07151F" : "#E6F4FE",
    ).catch(() => {
      // Ignore environments where the system UI API is unavailable.
    });
  }, [themeName]);

  useEffect(() => {
    // TODO: wire up PostHog screen tracking here once analytics is integrated.
    // eslint-disable-next-line no-console
    console.log("[screen]", pathname);
  }, [pathname]);

  return (
    <TamaguiProvider config={config} defaultTheme={themeName}>
      <Theme name={themeName}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
        </Stack>
        <StatusBar style={themeName === "dark" ? "light" : "dark"} />
      </Theme>
    </TamaguiProvider>
  );
}
