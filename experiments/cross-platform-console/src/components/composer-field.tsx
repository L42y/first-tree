import { forwardRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { LiveMarkdownInput, type LiveMarkdownInputHandle } from "~/components/live-markdown-input";
import { loadLiquidGlass } from "~/lib/liquid-glass";
import { colors } from "~/lib/theme";

type LiveMarkdownInputProps = React.ComponentProps<typeof LiveMarkdownInput>;

/**
 * The chat's writing surface, as a component both surfaces share. The ask
 * screen used to hand-roll its own bordered box, which meant a second input
 * with its own keyboard behaviour and its own look — the chat composer is the
 * one that is actually tuned for typing on this app, so answering a question
 * should use it rather than an imitation of it.
 */
export const ComposerField = forwardRef<
  LiveMarkdownInputHandle,
  LiveMarkdownInputProps & {
    /** Rendered above the input inside the same card (token usage, a label). */
    header?: ReactNode;
  }
>(function ComposerField({ header, style, ...inputProps }, ref) {
  const liquidGlass = loadLiquidGlass();
  const Surface = liquidGlass?.GlassView;

  const body = (
    <>
      {header}
      <View style={styles.row}>
        <LiveMarkdownInput
          ref={ref}
          {...inputProps}
          style={[Surface ? styles.glassInput : styles.input, style]}
          placeholderTextColor={inputProps.placeholderTextColor ?? colors.textMuted}
        />
      </View>
    </>
  );

  return Surface ? (
    <Surface style={styles.glassCard} glassEffectStyle="regular" colorScheme="dark" isInteractive>
      {body}
    </Surface>
  ) : (
    <View style={styles.card}>{body}</View>
  );
});

const styles = StyleSheet.create({
  card: {
    overflow: "hidden",
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingTop: 4,
    paddingBottom: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  glassCard: {
    overflow: "hidden",
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: "transparent",
    paddingTop: 4,
    paddingBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 6,
    gap: 8,
  },
  input: {
    flex: 1,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  glassInput: {
    flex: 1,
    borderRadius: 20,
    backgroundColor: "transparent",
  },
});
