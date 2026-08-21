# Cross-Platform Console

Experimental First Tree app shell built with [Expo](https://expo.dev) and [Tamagui](https://tamagui.dev).

## Scope

This is a **parallel experiment** in the private fork (`L42y/first-tree`). It does not replace the shipped Mobile Surface or Web Console today. The goal is to prove that a single Expo + Tamagui codebase can deliver the full console experience across:

| Target | v1 plan |
|--------|---------|
| Web (desktop + mobile browsers) | First-class |
| iOS | First-class |
| Android | First-class |
| macOS | Mac Catalyst build of the iOS app |

Windows and Linux native are explicitly out of scope for v1.

## Structure

```
experiments/cross-platform-console/
├── app.config.ts          # Expo configuration
├── babel.config.js        # Babel preset
├── metro.config.js        # Metro monorepo resolution
├── package.json           # Package scripts and dependencies
├── src/
│   ├── tamagui.config.ts  # Tamagui design-system config
│   └── app/
│       ├── _layout.tsx    # Root layout + theme + providers
│       └── index.tsx      # Home screen placeholder
└── assets/                # Icons and splash screens
```

## Getting started

```bash
cd experiments/cross-platform-console
pnpm install

# Web
pnpm dev

# iOS (macOS + Xcode)
pnpm ios

# Android
pnpm android
```

## Shared-code strategy

The scaffold starts self-contained. As the experiment matures, extract only the pieces the app needs from the existing web console:

- Auth session / token handling
- First Tree API client
- Shared domain types from `@first-tree/shared`

Avoid a big-bang rewrite of the existing web console.

## UI conventions

- The app is **dark-locked** (`userInterfaceStyle: "dark"` in `app.config.ts`) and every surface styles from the shared tokens in `src/lib/theme.ts` — never from the OS default.
- Every screen/component must set explicit `backgroundColor` and text `color` values (from those tokens). Raw React Native styles without colors inherit the platform light appearance and are a bug, not a style choice.

## Notes

- `app.config.ts` reads `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` from the environment at build time; they are not committed.
- The root `pnpm-workspace.yaml` includes this package so it can consume monorepo packages later.
