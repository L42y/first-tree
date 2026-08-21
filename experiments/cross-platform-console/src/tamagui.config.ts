import { defaultConfig } from "@tamagui/config/v5";
import { createTamagui } from "tamagui";

export const config = createTamagui({
  ...defaultConfig,
  settings: {
    ...defaultConfig.settings,
    // Expo is client-only; skip the SSR double-render.
    disableSSR: true,
    // Respect the user's system color scheme by default.
    shouldAddPrefersColorThemes: true,
  },
});

export type Conf = typeof config;

declare module "tamagui" {
  interface TamaguiCustomConfig extends Conf {}
}

export default config;
