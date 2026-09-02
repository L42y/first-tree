import { colors } from "./theme";

/**
 * Shared native-stack header theming for every (app) tab's own Stack —
 * headerLargeTitle collapses to a small centered title on scroll, the way
 * Apple's own apps do it. iOS-only in effect; other platforms show the
 * title as a plain header and ignore the large-title options.
 */
export const nativeHeaderOptions = {
  headerLargeTitle: true,
  headerShadowVisible: false,
  headerLargeTitleShadowVisible: false,
  headerStyle: { backgroundColor: colors.bg },
  headerLargeStyle: { backgroundColor: colors.bg },
  headerTintColor: colors.accent,
  headerTitleStyle: { color: colors.text },
  headerLargeTitleStyle: { color: colors.text },
} as const;
