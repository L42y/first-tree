import type { GlassViewProps } from "expo-glass-effect";
import type { ComponentType } from "react";
import { Platform } from "react-native";

export type LiquidGlassModule = {
  GlassView: ComponentType<GlassViewProps>;
  isGlassEffectAPIAvailable?: () => boolean;
  isLiquidGlassAvailable?: () => boolean;
};

/**
 * Resolve Liquid Glass lazily so an older dev client without the native module
 * falls back to an opaque surface instead of crashing while its JS is reloaded.
 */
export function loadLiquidGlass(): LiquidGlassModule | null {
  if (Platform.OS !== "ios") return null;
  try {
    const glass = require("expo-glass-effect") as LiquidGlassModule;
    if (!glass.isGlassEffectAPIAvailable?.() || !glass.isLiquidGlassAvailable?.()) return null;
    return glass;
  } catch {
    return null;
  }
}
