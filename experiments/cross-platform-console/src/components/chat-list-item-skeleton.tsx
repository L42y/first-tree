import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { colors } from "~/lib/theme";

/**
 * Placeholder rows shaped like ChatListItem, shown while the first page of
 * chats is still loading so the list never reads as "empty" before it has
 * actually loaded.
 */
export function ChatListSkeleton({ rows = 8 }: { rows?: number }) {
  const ids = Array.from({ length: rows }, (_, index) => `skeleton-${index}`);
  return (
    <View>
      {ids.map((id) => (
        <SkeletonRow key={id} />
      ))}
    </View>
  );
}

function SkeletonRow() {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View style={[styles.row, { opacity }]}>
      <View style={styles.avatar} />
      <View style={styles.content}>
        <View style={[styles.bar, styles.titleBar]} />
        <View style={[styles.bar, styles.previewBar]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceStrong,
  },
  content: {
    flex: 1,
    gap: 8,
  },
  bar: {
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.surfaceStrong,
  },
  titleBar: {
    width: "50%",
  },
  previewBar: {
    width: "80%",
  },
});
