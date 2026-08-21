import { defaultConfig } from "@tamagui/config/v5";
import { createTamagui } from "tamagui";

export const config = createTamagui({
  ...defaultConfig,
  settings: {
    ...defaultConfig.settings,
    // Expo is client-only; skip the SSR double-render.
    disableSSR: true,
    // Dark-first like first-tree.ai; the root layout pins the dark theme.
    shouldAddPrefersColorThemes: true,
  },
});

export type Conf = typeof config;

declare module "tamagui" {
  interface TamaguiCustomConfig extends Conf {}
}

export default config;
