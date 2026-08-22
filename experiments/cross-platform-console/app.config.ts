const config = {
  name: "First Tree",
  slug: "first-tree",
  owner: "resumed",
  version: "0.1.0",
  orientation: "default",
  icon: "./assets/icon.png",
  // Deep-link scheme — prerequisite for OAuth link/unlink round-trips on
  // device builds and silences the router's Linking warning.
  scheme: "first-tree",
  // Dark-locked: the app never follows the OS appearance. Every screen
  // must still style from ~/lib/theme tokens — this only guarantees the
  // system chrome and root window are dark when one is missed.
  userInterfaceStyle: "dark",
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#07151F",
  },
  assetBundlePatterns: ["**/*"],
  ios: {
    supportsTablet: true,
    bundleIdentifier: "ai.firsttree.console",
    requireFullScreen: true,
    infoPlist: {
      UIViewControllerBasedStatusBarAppearance: true,
      // Standard HTTPS/OS crypto only — export-exempt (answered via EAS prompt).
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    package: "ai.firsttree.console",
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon: "./assets/favicon.png",
  },
  plugins: ["expo-router"],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    // Populated from environment at build time; never commit secrets.
    posthogProjectToken: process.env.POSTHOG_PROJECT_TOKEN,
    posthogHost: process.env.POSTHOG_HOST,
    eas: {
      projectId: "d699f105-05da-42dd-a7fd-f023648b7935",
    },
  },
};

export default config;
