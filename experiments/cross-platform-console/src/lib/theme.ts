/**
 * Dark-first palette for the experiment app, modeled on first-tree.ai's
 * near-black brand canvas (the same values the root layout registers with
 * expo-system-ui). Every screen styles against these tokens so the whole
 * surface is dark regardless of OS appearance.
 */
export const colors = {
  /** Page canvas. */
  bg: "#07151F",
  /** Raised surfaces: cards, inputs, bubbles, chips. */
  surface: "rgba(255,255,255,0.06)",
  surfaceStrong: "rgba(255,255,255,0.10)",
  border: "rgba(255,255,255,0.14)",
  text: "#E8F1F5",
  textSecondary: "rgba(232,241,245,0.64)",
  textMuted: "rgba(232,241,245,0.42)",
  accent: "#3B82F6",
  accentText: "#FFFFFF",
  danger: "#EF4444",
} as const;
