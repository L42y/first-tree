import { useBottomTabBarHeight } from "expo-router/js-tabs";
import { useWindowDimensions } from "react-native";

/**
 * The (app) tab bar floats over content on phones/narrow tablets (see
 * (app)/_layout.tsx), so screens must reserve this much bottom padding
 * themselves — the wide sidebar rail stays docked and needs none.
 */
export function useTabBarFloatingInset(): number {
  const { width } = useWindowDimensions();
  const tabBarHeight = useBottomTabBarHeight();
  return width >= 1024 ? 0 : tabBarHeight;
}
