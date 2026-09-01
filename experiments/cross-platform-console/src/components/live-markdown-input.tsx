import { useRef } from "react";
import {
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";

import { MarkdownText } from "~/components/markdown-text";
import { colors } from "~/lib/theme";

type LiveMarkdownInputProps = Omit<TextInputProps, "style"> & {
  /** Outer sizing/background styles; the editable and rendered layers share it. */
  style?: StyleProp<ViewStyle>;
  placeholder?: string;
  placeholderTextColor?: string;
  /** Keep the invisible editing layer and visible Markdown layer aligned. */
  paddingHorizontal?: number;
  paddingVertical?: number;
};

/**
 * A native multiline editor whose visible text is Markdown. The input remains
 * editable and keeps the system caret/selection; its glyphs are transparent,
 * while the same value is rendered live underneath it.
 */
export function LiveMarkdownInput({
  value,
  onChangeText,
  style,
  placeholder,
  placeholderTextColor = colors.textMuted,
  paddingHorizontal = 16,
  paddingVertical = 10,
  ...inputProps
}: LiveMarkdownInputProps) {
  const previewRef = useRef<ScrollView>(null);

  return (
    <View style={[styles.container, style]}>
      <ScrollView
        ref={previewRef}
        style={StyleSheet.absoluteFill}
        contentContainerStyle={[styles.previewContent, { paddingHorizontal, paddingVertical }]}
        scrollEnabled={false}
        pointerEvents="none"
      >
        {value ? <MarkdownText value={value} /> : null}
        {!value && placeholder ? (
          <Text style={[styles.placeholder, { color: placeholderTextColor }]}>{placeholder}</Text>
        ) : null}
      </ScrollView>

      <TextInput
        {...inputProps}
        value={value}
        onChangeText={onChangeText}
        style={[
          StyleSheet.absoluteFill,
          styles.input,
          {
            paddingHorizontal,
            paddingVertical,
          },
        ]}
        selectionColor={colors.accent}
        onScroll={(event) => {
          previewRef.current?.scrollTo({
            y: event.nativeEvent.contentOffset.y,
            animated: false,
          });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
  },
  previewContent: {
    minHeight: "100%",
  },
  placeholder: {
    fontSize: 16,
    lineHeight: 21,
  },
  input: {
    backgroundColor: "transparent",
    color: "transparent",
    fontSize: 16,
    lineHeight: 21,
  },
});
