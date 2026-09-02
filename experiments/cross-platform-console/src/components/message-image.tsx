import { useEffect, useState } from "react";
import { ActivityIndicator, Image, type ImageStyle, type StyleProp, StyleSheet, Text, View } from "react-native";

import { getStoredTokens, refreshAccessToken } from "~/lib/api";
import { API_BASE_URL } from "~/lib/env";

type MessageImageProps = {
  imageId?: string;
  dataUri?: string;
  filename: string;
  style?: StyleProp<ImageStyle>;
};

type ImageState =
  | { kind: "loading"; uri?: string }
  | { kind: "ready"; uri: string }
  | { kind: "gone"; filename: string }
  | { kind: "error"; filename: string };

/**
 * Message attachment bytes require the same bearer session as the API. Keep
 * the token out of the component tree and turn an expired access token into a
 * one-time refresh before handing the immutable URL to the native image cache.
 */
export function MessageImage({ imageId, dataUri, filename, style }: MessageImageProps) {
  const [state, setState] = useState<ImageState>({ kind: "loading" });

  useEffect(() => {
    if (dataUri) {
      setState({ kind: "ready", uri: dataUri });
      return;
    }
    if (!imageId) {
      setState({ kind: "error", filename });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      let token = (await getStoredTokens())?.accessToken;
      if (!token) {
        if (!cancelled) setState({ kind: "error", filename });
        return;
      }
      let response = await fetch(`${API_BASE_URL}/api/v1/attachments/${encodeURIComponent(imageId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        const refreshed = await refreshAccessToken();
        if (!refreshed?.accessToken) {
          if (!cancelled) setState({ kind: "error", filename });
          return;
        }
        token = refreshed.accessToken;
        response = await fetch(`${API_BASE_URL}/api/v1/attachments/${encodeURIComponent(imageId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      if (!cancelled) {
        setState(
          response.ok
            ? {
                kind: "ready",
                uri: `${API_BASE_URL}/api/v1/attachments/${encodeURIComponent(imageId)}`,
              }
            : response.status === 404
              ? { kind: "gone", filename }
              : { kind: "error", filename },
        );
      }
    })().catch(() => {
      if (!cancelled) setState({ kind: "error", filename });
    });
    return () => {
      cancelled = true;
    };
  }, [dataUri, filename, imageId]);

  if (state.kind === "ready") {
    return (
      <Image
        source={{ uri: state.uri }}
        style={[styles.image, style]}
        accessibilityLabel={filename}
        resizeMode="cover"
      />
    );
  }
  if (state.kind === "gone") {
    return <Text style={styles.note}>Image “{filename}” expired or unavailable</Text>;
  }
  if (state.kind === "error") {
    return <Text style={styles.note}>Image “{filename}” failed to load</Text>;
  }
  return (
    <View style={styles.loading}>
      <ActivityIndicator />
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    width: 240,
    height: 240,
    borderRadius: 14,
  },
  loading: {
    width: 240,
    height: 180,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  note: {
    color: "#9CA3AF",
    fontSize: 13,
    fontStyle: "italic",
  },
});
