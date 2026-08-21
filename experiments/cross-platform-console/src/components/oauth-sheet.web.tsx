import { useEffect } from "react";
import type { OAuthCompletion, SignInProvider } from "~/lib/oauth";
import { oauthStartUrl } from "~/lib/oauth";

/**
 * Web fallback for the OAuth sheet. react-native-webview has no web
 * implementation (and embedding the provider consent in an iframe is
 * blocked by both Google and GitHub), so on web we do what the web
 * console itself does: a full-page navigation to the server's
 * `/auth/<provider>/start`. The completion page adopts the session into
 * the deployment's own web app.
 *
 * The component therefore never renders a visible surface: mounting it
 * starts the redirect. `onComplete` stays unused here — tokens come back
 * only through same-origin hosting of the export, which is a later step.
 */
export function OAuthSheet(props: {
  provider: SignInProvider | null;
  onClose: () => void;
  onComplete: (completion: OAuthCompletion) => void;
}) {
  const { provider, onClose } = props;

  useEffect(() => {
    if (!provider) return;
    window.location.href = oauthStartUrl(provider);
    onClose();
  }, [provider, onClose]);

  return null;
}
