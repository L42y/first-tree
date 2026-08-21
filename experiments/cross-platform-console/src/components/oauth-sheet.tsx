import type { OAuthCompletion, SignInProvider } from "~/lib/oauth";
import { parseCompletionUrl } from "~/lib/oauth";
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
 * Completion detection is layered, because engines differ in whether
 * navigation callbacks expose URL fragments:
 *
 *  1. `onShouldStartLoadWithRequest` / `onNavigationStateChange` parse the
 *     navigation URL when the fragment is visible there.
 *  2. A document-start user script (injected BEFORE any page JS) samples
 *     `location.href` synchronously — this is the reliable path on iOS,
 *     because the completion page is a React SPA whose first effect calls
 *     `history.replaceState` and wipes the fragment within milliseconds.
 *  3. The same script keeps polling briefly in case injection timing slips.
 *
 * The token-bearing URL is never rendered as a page.
 */

/**
 * Runs at document start AND document end. Reports the completion URL via
 * postMessage as soon as the location matches a server callback landing
 * path. Only reports once a hash is present (the fragment IS part of the
 * navigation URL at document start), with a bounded retry loop for late
 * injections.
 */
const BRIDGE_JS = `
(function() {
  var RE = /^\\/auth\\/(github\\/|google\\/)?complete$/;
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
    const completion = parseCompletionUrl(nav.url);
    if (completion) onComplete(completion);
  };

  // First gate: never even load the token-bearing URL when the engine
  // exposes the fragment here.
  const onShouldStartLoadWithRequest = (request: { url: string }) => {
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
    backgroundColor: colors.bg,
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
