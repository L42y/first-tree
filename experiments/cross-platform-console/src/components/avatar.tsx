import { Image, StyleSheet, Text, View } from "react-native";

/**
 * Avatar for humans and agents (robots), mirroring the web console's
 * avatar semantics (packages/web/src/components/chat/chat-row-avatar.tsx):
 *
 *   - uploaded image (`avatarImageUrl`) wins when present;
 *   - otherwise a colored disc: the manager-selected `avatarColorToken`
 *     ("hue-0".."hue-7"), else a deterministic djb2 hash of the seed
 *     (agentId) into the same 8-hue palette — same agent, same hue
 *     everywhere;
 *   - a small corner glyph distinguishes the kind: 🤖 for agents,
 *     👤 for humans.
 */

/** The web console's `--avatar-hue-0..7` tokens converted to sRGB hex. */
const HUES = [
  "#33AC5A", // green (empty-seed fallback)
  "#1289E7", // blue
  "#8A63DE", // purple
  "#E94B8A", // pink
  "#E4762C", // orange
  "#00A6AE", // teal
  "#C99F00", // amber
  "#4C66D3", // indigo
] as const;

const AVATAR_HUE_COUNT = HUES.length;

/** Same djb2 variant as the web's `pickAvatarHue`. */
export function pickAvatarHueIndex(seed: string): number {
  if (seed.length === 0) return 0;
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33) ^ seed.charCodeAt(i);
  }
  return Math.abs(hash) % AVATAR_HUE_COUNT;
}

/** Manager override → hue index; unrecognised tokens fall back to the hash. */
export function resolveAvatarHueIndex(colorToken: string | null | undefined, seed: string): number {
  if (typeof colorToken === "string") {
    const match = /^hue-([0-7])$/.exec(colorToken);
    if (match) return Number(match[1]);
  }
  return pickAvatarHueIndex(seed);
}

export type AvatarKind = "human" | "agent";

function initialsFor(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

export function Avatar({
  name,
  seed,
  colorToken,
  imageUrl,
  kind = "agent",
  size = 40,
  showKindGlyph = true,
}: {
  /** Display name — initials fallback source. */
  name: string;
  /** Stable identity for hue hashing (agentId preferred). */
  seed: string;
  /** Manager-selected "hue-N" token, or null. */
  colorToken?: string | null;
  /** Uploaded avatar image URL, or null. */
  imageUrl?: string | null;
  /** Drives the corner kind glyph. */
  kind?: AvatarKind;
  /** Pixel diameter. */
  size?: number;
  /** Render the 🤖/👤 corner badge. */
  showKindGlyph?: boolean;
}) {
  const hue = HUES[resolveAvatarHueIndex(colorToken, seed)];

  // Clean shape language instead of emoji badges:
  //   human → thin light ring around the avatar
  //   agent → small accent dot bottom-right
  const isHuman = kind === "human";
  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <View
        style={[
          isHuman ? styles.humanRing : null,
          { width: size, height: size, borderRadius: 9999 },
        ]}
      >
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={[styles.image, { width: size, height: size }]} />
        ) : (
          <View style={[styles.disc, { width: size, height: size, backgroundColor: hue }]}>
            <Text style={[styles.initials, { fontSize: Math.round(size * 0.36) }]}>
              {initialsFor(name)}
            </Text>
          </View>
        )}
      </View>
      {showKindGlyph && !isHuman && (
        <View style={[styles.agentDot, { width: Math.max(8, size * 0.22), height: Math.max(8, size * 0.22) }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
    flexShrink: 1,
  },
  image: {
    borderRadius: 9999,
  },
  disc: {
    borderRadius: 9999,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    fontWeight: "700",
    color: "#FFFFFF",
  },
  humanRing: {
    borderWidth: 2,
    borderColor: "rgba(232,241,245,0.85)",
    overflow: "hidden",
  },
  agentDot: {
    position: "absolute",
    right: -2,
    bottom: -2,
    borderRadius: 9999,
    backgroundColor: "#00A6E7",
    borderWidth: 2,
    borderColor: "#07151F",
  },
});
