/**
 * Shared parsing of the First Tree OAuth callback landing URLs.
 *
 * After the provider round-trip the server 302s to its SPA completion
 * page with the outcome in the URL fragment:
 *   - GitHub:  /auth/github/complete#access=…&refresh=…   (or #error=<code>)
 *   - Google:  /auth/complete#access=…&refresh=…          (or #error=<code>)
 *
 * Mirrors packages/web/src/pages/oauth-complete.tsx — keep the path
 * regex and parameter names in sync with the server routes in
 * packages/server/src/api/auth/{github,google}.ts.
 */

import { API_BASE_URL } from "./env";

export type SignInProvider = "google" | "github" | "oidc";

export const COMPLETE_PATH_RE = /^\/auth\/(github\/|google\/)?complete\/?(\?.*)?$/;

export type OAuthCompletion =
  | { kind: "success"; accessToken: string; refreshToken: string }
  | { kind: "error"; code: string };

/** True when the URL is a server callback landing page (any hash state). */
export function isCompletionPath(url: string): boolean {
  try {
    return COMPLETE_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Parse definitive completion data from the URL fragment. Returns null when
 * the URL has no fragment yet — engines frequently report redirect targets
 * without their fragment in navigation callbacks, and treating that as an
 * error both blocks the page load (preventing document-start capture) and
 * fabricates failures.
 */
export function parseCompletionUrl(url: string): OAuthCompletion | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!COMPLETE_PATH_RE.test(parsed.pathname)) return null;
  const hash = parsed.hash.replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const errorCode = params.get("error");
  if (errorCode) return { kind: "error", code: errorCode };
  const accessToken = params.get("access");
  const refreshToken = params.get("refresh");
  if (accessToken && refreshToken) return { kind: "success", accessToken, refreshToken };
  return null;
}

/** Friendly copy for callback error codes — subset of the web console's map. */
export const CALLBACK_ERROR_COPY: Record<string, string> = {
  "state-expired": "This authentication request took too long or was already used. Head back and start again.",
  "provider-denied": "Authorization was canceled. Head back and start again when you're ready.",
  "provider-not-configured": "This sign-in provider is not configured on this First Tree deployment.",
  "provider-unavailable": "The sign-in provider is temporarily unavailable. Please try again in a moment.",
  "provider-exchange-failed": "The sign-in provider did not accept the authentication handshake. Try again.",
  "identity-conflict": "That external account already belongs to another First Tree user.",
  "sign-in-method-disabled": "This sign-in method is disabled on this deployment.",
  "invite-invalid": "This invitation link is no longer valid.",
  "invite-required": "This server requires an invitation link to join.",
  "account-inactive": "This First Tree account is suspended.",
};

export function oauthStartUrl(provider: SignInProvider): string {
  return `${API_BASE_URL}/api/v1/auth/${provider}/start`;
}
