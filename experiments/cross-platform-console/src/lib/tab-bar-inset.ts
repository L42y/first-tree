import { BottomTabBarHeightContext } from "expo-router/js-tabs";
import { useContext } from "react";
import { useWindowDimensions } from "react-native";

/**
 * Android/web render the classic expo-router/js-tabs floating bar (see
 * (app)/_layout.tsx), so screens reserve this much bottom padding
 * themselves. iOS renders NativeTabs instead, whose automatic
 * content-inset adjustment already reserves that space — there is no
 * BottomTabBarHeightContext.Provider there, so this reads as 0.
 */
export function useTabBarFloatingInset(): number {
  const { width } = useWindowDimensions();
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;
  return width >= 1024 ? 0 : tabBarHeight;
}
