import { useRef, useState } from "react";
import {
  type NativeSyntheticEvent,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputContentSizeChangeEventData,
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

const MAX_EDITOR_HEIGHT = 120;

/**
 * Expo Go cannot host EnrichedMarkdownTextInput's native view, so the editor
 * keeps a real TextInput for interaction and renders its value with the same
 * MarkdownText used by messages. Content from either layer determines height;
 * once the editor reaches its maximum, TextInput scrolling drives the preview.
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
  const [nativeContentHeight, setNativeContentHeight] = useState<number | null>(null);
  const [previewContentHeight, setPreviewContentHeight] = useState<number | null>(null);
  const minimumEditorHeight = paddingVertical * 2 + 21;
  const editorHeight = Math.min(
    Math.max(nativeContentHeight ?? 0, previewContentHeight ?? 0, minimumEditorHeight),
    MAX_EDITOR_HEIGHT,
  );

  const updateNativeContentHeight = (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
    setNativeContentHeight(event.nativeEvent.contentSize.height + paddingVertical * 2);
  };

  return (
    <View style={[styles.container, style]}>
      <View style={[styles.editor, { height: editorHeight }]}>
        <ScrollView
          ref={previewRef}
          style={StyleSheet.absoluteFill}
          contentContainerStyle={[styles.previewContent, { paddingHorizontal, paddingVertical }]}
          scrollEnabled={false}
          pointerEvents="none"
          onContentSizeChange={(_, height) => setPreviewContentHeight(height)}
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
          onContentSizeChange={updateNativeContentHeight}
          onScroll={(event) => {
            previewRef.current?.scrollTo({
              y: event.nativeEvent.contentOffset.y,
              animated: false,
            });
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
  },
  editor: {
    minHeight: 41,
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
