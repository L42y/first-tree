import type { OAuthCompletion, SignInProvider } from "~/lib/oauth";
import { parseCompletionUrl } from "~/lib/oauth";
import { oauthStartUrl } from "~/lib/oauth";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { WebViewNavigation } from "react-native-webview";

/**
 * Native OAuth sheet: an in-app browser (react-native-webview) running the
 * exact flow the web console runs — server-signed state, provider consent,
 * fragment redirect. The WebView intercepts the completion navigation so
 * the token-bearing URL is never rendered.
 */
export function OAuthSheet(props: {
  provider: SignInProvider | null;
  onClose: () => void;
  onComplete: (completion: OAuthCompletion) => void;
}) {
  const { provider, onClose, onComplete } = props;
  const startUrl = provider ? oauthStartUrl(provider) : null;

  const onNavigationStateChange = (nav: WebViewNavigation) => {
    const completion = parseCompletionUrl(nav.url);
    if (completion) onComplete(completion);
  };

  // First gate: never even load the token-bearing URL.
  const onShouldStartLoadWithRequest = (request: { url: string }) => {
    const completion = parseCompletionUrl(request.url);
    if (completion) {
      onComplete(completion);
      return false;
    }
    return true;
  };

  // Backup gate: some engines strip the fragment from navigation events,
  // so ask the document for its real location once it lands.
  const injectedJavaScript = `
    (function() {
      function report() {
        try {
          if (/^\\/auth\\/(github\\/|google\\/)?complete$/.test(window.location.pathname)) {
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
              JSON.stringify({ type: 'oauth-complete', href: window.location.href })
            );
          }
        } catch (e) {}
      }
      report();
      setTimeout(report, 250);
      true;
    })();
  `;

  const onMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: string; href?: string };
      if (message.type === "oauth-complete" && message.href) {
        const completion = parseCompletionUrl(message.href);
        if (completion) onComplete(completion);
      }
    } catch {
      // Ignore malformed bridge messages.
    }
  };

  return (
    <Modal visible={provider !== null} animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.sheetClose}>Close</Text>
          </Pressable>
        </View>
        {startUrl && (
          <WebView
            key={provider}
            source={{ uri: startUrl }}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            onNavigationStateChange={onNavigationStateChange}
            injectedJavaScript={injectedJavaScript}
            onMessage={onMessage}
            javaScriptEnabled
            style={styles.webView}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: "#fff",
  },
  sheetHeader: {
    paddingTop: 48,
    paddingHorizontal: 16,
    paddingBottom: 8,
    alignItems: "flex-end",
  },
  sheetClose: {
    fontSize: 16,
    color: "#3B82F6",
  },
  webView: {
    flex: 1,
  },
});
