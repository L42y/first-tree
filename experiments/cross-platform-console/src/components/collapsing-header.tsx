import type { ReactNode } from "react";
import { useRef } from "react";
import { Animated, type NativeScrollEvent, type NativeSyntheticEvent, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "~/lib/theme";

/**
 * Hand-rolled large-title collapse, driven by scroll offset instead of the
 * native headerLargeTitle: NativeTabs' nested-Stack header doesn't track a
 * scroll view correctly on iOS when the tab's content is a ScrollView/FlatList
 * (open expo-router bug, expo/expo#40717) — the title just sits there large,
 * static, no animation, regardless of how the content is structured. This
 * bypasses that entirely by animating our own title block instead of relying
 * on the broken native one.
 *
 * Two separate title elements (the large one is scrollable content, the
 * compact one lives in the overlay bar) rather than one element morphing —
 * that's the same technique UIKit itself uses (a collapsing large-title
 * container cross-fading with the compact bar), not a shortcut. Both ends
 * animate scale/position/opacity together so the handoff reads as one
 * continuous motion instead of two independent, disconnected fades.
 *
 * Plain Animated (native-driven), not react-native-reanimated: this is a
 * scroll-position interpolation, exactly what Animated.event with
 * useNativeDriver already handles at 60fps — reanimated is a native module
 * that isn't compiled into the installed dev client yet, so pulling it in
 * for this would mean another EAS build + reinstall for no visual gain here.
 */

export const COLLAPSED_BAR_HEIGHT = 44;
// The animation runs over the large title's own height: by the time it has
// scrolled fully out of view, the compact bar has fully taken over.
const LARGE_TITLE_HEIGHT = 52;

export function useCollapsingHeaderScroll(onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void) {
  const scrollY = useRef(new Animated.Value(0)).current;
  // Animated.event is built once (native-driven, can't be recreated per
  // render), so the listener it calls must read from a ref kept fresh every
  // render rather than closing over the onScroll passed in on mount.
  const listenerRef = useRef(onScroll);
  listenerRef.current = onScroll;
  const handleScroll = useRef(
    Animated.event<NativeScrollEvent>([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
      useNativeDriver: true,
      listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => listenerRef.current?.(e),
    }),
  ).current;
  return { scrollY, onScroll: handleScroll };
}

/**
 * Renders as the first item of the scrollable content. It both scrolls away
 * naturally with the content *and* actively shrinks/fades/lifts as it goes,
 * so the motion reads as the title collapsing rather than just content
 * sliding off-screen.
 */
export function LargeTitle({ children, scrollY }: { children: string; scrollY: Animated.Value }) {
  const opacity = scrollY.interpolate({
    inputRange: [0, LARGE_TITLE_HEIGHT * 0.8],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });
  const scale = scrollY.interpolate({
    inputRange: [0, LARGE_TITLE_HEIGHT],
    outputRange: [1, 0.82],
    extrapolate: "clamp",
  });
  const translateY = scrollY.interpolate({
    inputRange: [0, LARGE_TITLE_HEIGHT],
    outputRange: [0, -10],
    extrapolate: "clamp",
  });

  return (
    <View style={styles.largeTitleWrap}>
      <Animated.Text
        style={[styles.largeTitleText, { opacity, transform: [{ scale }, { translateY }] }]}
        // The large title only ever shrinks toward its own left edge (it
        // never needs to be centered — it hands off to the compact bar's
        // own centered title instead), so anchor the scale there.
      >
        {children}
      </Animated.Text>
    </View>
  );
}

export function CollapsingHeaderBar({
  title,
  scrollY,
  headerLeft,
  headerRight,
}: {
  title: string;
  scrollY: Animated.Value;
  headerLeft?: ReactNode;
  headerRight?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const barOpacity = scrollY.interpolate({
    inputRange: [0, LARGE_TITLE_HEIGHT],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });
  const titleOpacity = scrollY.interpolate({
    inputRange: [LARGE_TITLE_HEIGHT * 0.45, LARGE_TITLE_HEIGHT],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });
  const titleTranslateY = scrollY.interpolate({
    inputRange: [LARGE_TITLE_HEIGHT * 0.45, LARGE_TITLE_HEIGHT],
    outputRange: [8, 0],
    extrapolate: "clamp",
  });
  const titleScale = scrollY.interpolate({
    inputRange: [LARGE_TITLE_HEIGHT * 0.45, LARGE_TITLE_HEIGHT],
    outputRange: [0.92, 1],
    extrapolate: "clamp",
  });

  return (
    <View style={[styles.barContainer, { height: insets.top + COLLAPSED_BAR_HEIGHT }]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.barBackground, { opacity: barOpacity }]} />
      <Animated.View style={[styles.barBorder, { opacity: barOpacity }]} />
      <View style={[styles.barRow, { top: insets.top }]}>
        <View style={styles.barSide}>{headerLeft}</View>
        <Animated.Text
          style={[
            styles.barTitle,
            { opacity: titleOpacity, transform: [{ translateY: titleTranslateY }, { scale: titleScale }] },
          ]}
          numberOfLines={1}
        >
          {title}
        </Animated.Text>
        <View style={[styles.barSide, styles.barSideRight]}>{headerRight}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  largeTitleWrap: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  largeTitleText: {
    fontSize: 34,
    fontWeight: "bold",
    color: colors.text,
    transformOrigin: "left",
  },
  barContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  barBackground: {
    backgroundColor: colors.bg,
  },
  barBorder: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  barRow: {
    position: "absolute",
    left: 0,
    right: 0,
    height: COLLAPSED_BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
  },
  barSide: {
    minWidth: 40,
    alignItems: "flex-start",
  },
  barSideRight: {
    alignItems: "flex-end",
  },
  barTitle: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 17,
    fontWeight: "600",
    color: colors.text,
  },
});
