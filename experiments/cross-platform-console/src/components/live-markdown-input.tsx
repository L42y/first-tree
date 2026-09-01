import {
  type MarkdownStyle,
  MarkdownTextInput,
  type MarkdownTextInputProps,
  parseExpensiMark,
} from "@expensify/react-native-live-markdown";
import { type ComponentRef, forwardRef } from "react";
import { type StyleProp, StyleSheet, type TextStyle } from "react-native";

import { colors } from "~/lib/theme";

type LiveMarkdownInputProps = Omit<MarkdownTextInputProps, "markdownStyle" | "parser" | "style"> & {
  style?: StyleProp<TextStyle>;
  /** Lines kept visible even after the controlled value becomes empty. */
  minLines?: number;
  /** Upper bound while the composer is in its ordinary state. */
  maxLines?: number;
};

export type LiveMarkdownInputHandle = ComponentRef<typeof MarkdownTextInput>;

const LINE_HEIGHT = 21;
const VERTICAL_PADDING = 20;

const markdownStyle: MarkdownStyle = {
  syntax: { color: colors.textMuted },
  link: { color: colors.accent },
  h1: { fontSize: 20 },
  blockquote: {
    borderColor: colors.accent,
    borderWidth: 2,
    marginLeft: 6,
    paddingLeft: 6,
  },
  code: {
    color: colors.text,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    fontFamily: "Menlo",
    fontSize: 15,
  },
  pre: {
    color: colors.text,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    fontFamily: "Menlo",
    fontSize: 15,
  },
  mentionHere: {
    color: colors.accent,
    backgroundColor: colors.surface,
  },
  mentionUser: {
    color: colors.accent,
    backgroundColor: colors.surface,
  },
  mentionReport: {
    color: colors.accent,
    backgroundColor: colors.surface,
  },
};

/**
 * Expensify's native live-markdown editor. Formatting is applied directly to
 * the editable text by its UI-thread parser; this wrapper only applies the
 * console theme and shared editor styles.
 */
export const LiveMarkdownInput = forwardRef<LiveMarkdownInputHandle, LiveMarkdownInputProps>(function LiveMarkdownInput(
  { style, minLines = 1, maxLines = 3, ...inputProps },
  ref,
) {
  return (
    <MarkdownTextInput
      {...inputProps}
      ref={ref}
      numberOfLines={inputProps.numberOfLines ?? maxLines}
      style={[
        styles.input,
        style,
        {
          minHeight: minLines * LINE_HEIGHT + VERTICAL_PADDING,
          maxHeight: maxLines * LINE_HEIGHT + VERTICAL_PADDING,
        },
      ]}
      parser={parseExpensiMark}
      markdownStyle={markdownStyle}
    />
  );
});

const styles = StyleSheet.create({
  input: {
    minHeight: 41,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    lineHeight: 21,
    color: colors.text,
  },
});
