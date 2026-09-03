import { API_BASE_URL } from "./env";

/**
 * Absolute URI for an avatar. The server synthesises uploaded-avatar URLs as
 * server-relative paths (`/api/v1/agents/<uuid>/avatar?v=…`) because the web
 * console resolves them against its own origin. A native `Image` has no
 * origin to resolve against, so those agents rendered as empty circles until
 * the API host is put back in front. External avatars (a user's GitHub image)
 * are already absolute and pass through untouched.
 */
export function resolveAvatarUri(url: string | null | undefined, baseUrl: string = API_BASE_URL): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return trimmed;
  return `${baseUrl.replace(/\/+$/, "")}/${trimmed.replace(/^\/+/, "")}`;
}
