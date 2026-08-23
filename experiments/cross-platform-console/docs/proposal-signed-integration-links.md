# Proposal: signed one-time URLs for integration link/unlink on mobile

Status: PROPOSAL (needs product sign-off before any server change).
Context: the mobile experiment authenticates with **bearer tokens**, while every
integration browser flow (OAuth link/unlink, GitHub App install) is built around
**server-side web sessions + cookies**. A plain WebView cannot carry the bearer
token through those flows, and leaking it into third-party pages is unacceptable.

## Proposed mechanism — server-side signed one-time "bridge" URLs

1. **New authenticated endpoint**
   `POST /api/v1/me/auth-providers/:provider/link/start`
   Auth: bearer token. Body: optional `next` intent metadata.
   Server responds: `{ url, expiresAt }`.

2. **Bridge route**
   The returned `url` points at e.g. `/api/v1/auth/bridge/:nonce`. The nonce is:
   - single-use, 60-second TTL,
   - HMAC-signed (existing `secrets.jwtSecret`) and bound server-side to
     `{userId, provider, intent}`,
   - exchanged exactly once for a real session-scoped redirect into the normal
     provider flow (`/me/auth-providers/:provider/link/start` internals).

3. **Completion**
   Existing callback routes finish unchanged and land on the SPA's
   `/auth/complete`-style page. For device builds we add a parallel landing that
   renders a minimal "Connected ✓ You can close this page" screen; the app
   simply polls `GET /me/auth-providers` (2s × 15) and refreshes when the
   identity appears.

4. **Unlink**
   Pure API: `POST /me/auth-providers/:provider/unlink/start` already exists in
   shape — callable directly with the bearer token; no browser hop required
   (subject to each provider's own revocation semantics).

## Why not the alternatives

- **Cookie bridge**: sharing web-session cookies into the app WebView couples
  mobile auth to web sessions and widens token blast radius.
- **Custom header injection in WebView**: headers propagate across redirects —
  the bearer token would reach accounts.google.com / github.com. Non-starter.

## Scope of server change

One new route file (~80 lines) reusing existing sign/verify helpers; no changes
to existing OAuth routes. Feature-flagged per channel if wanted.

## Mobile effort

Small: fetch signed URL → open WebView sheet (existing component) → poll
providers → refresh Integrations section.
