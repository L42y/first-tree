import type { OAuthCompletion, SignInProvider } from "~/lib/oauth";
import { isCompletionPath, parseCompletionUrl } from "~/lib/oauth";
import { oauthStartUrl } from "~/lib/oauth";
import { colors } from "~/lib/theme";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { WebViewNavigation } from "react-native-webview";

/**
 * Native OAuth sheet: an in-app browser (react-native-webview) running the
 * exact flow the web console runs — server-signed state, provider consent,
 * fragment redirect.
 *
 * Completion detection is layered:
 *  1. Navigation gates parse the URL when its fragment is visible there.
 *     IMPORTANT: a completion-path URL WITHOUT a hash is NOT treated as a
 *     result — iOS reports redirect targets without their fragment, and
 *     blocking that navigation would prevent the document-start bridge
 *     below from ever reading it. We allow the load instead.
 *  2. A document-start user script samples `location.href` before any page
 *     JS runs (the completion SPA wipes the fragment via history.replaceState
 *     within milliseconds) and posts it over the WebView message bridge.
 *  3. The same script keeps polling briefly in case injection timing slips.
 */

const BRIDGE_JS = `
(function() {
  var RE = /^\\/auth\\/(github\\/|google\\/)?complete\\/?(\\?.*)?$/;
  var attempts = 0;
  var timer = null;
  function report() {
    try {
      if (!RE.test(window.location.pathname)) return;
      var hash = window.location.hash || '';
      if (!hash) return;
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'oauth-complete', href: window.location.href })
      );
      stop();
    } catch (e) {}
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  report();
  timer = setInterval(function() {
    attempts += 1;
    if (attempts > 40) { stop(); return; }
    report();
  }, 100);
})();
`;

export function OAuthSheet(props: {
  provider: SignInProvider | null;
  onClose: () => void;
  onComplete: (completion: OAuthCompletion) => void;
}) {
  const { provider, onClose, onComplete } = props;
  const startUrl = provider ? oauthStartUrl(provider) : null;

  const onNavigationStateChange = (nav: WebViewNavigation) => {
    if (__DEV__) console.log("[oauth] nav:", nav.url);
    const completion = parseCompletionUrl(nav.url);
    if (completion) onComplete(completion);
  };

  // Only block the load when the fragment data is actually present.
  const onShouldStartLoadWithRequest = (request: { url: string }) => {
    if (__DEV__ && isCompletionPath(request.url)) {
      console.log("[oauth] shouldLoad (completion path):", request.url);
    }
    const completion = parseCompletionUrl(request.url);
    if (completion) {
      onComplete(completion);
      return false;
    }
    return true;
  };

  const onMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: string; href?: string };
      if (__DEV__) console.log("[oauth] bridge message:", event.nativeEvent.data);
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
            injectedJavaScriptBeforeContentLoaded={BRIDGE_JS}
            injectedJavaScript={BRIDGE_JS}
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
    color: colors.accent,
  },
  webView: {
    flex: 1,
  },
});
