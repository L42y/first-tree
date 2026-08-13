import { MESSAGE_ATTACHMENT_RETENTION_DAYS } from "@first-tree/shared";
import { useEffect, useState } from "react";
import { fetchAttachmentBase64 } from "../api/attachments.js";
import { ApiError } from "../api/client.js";
import { getImage, putImage } from "../api/image-store.js";

/**
 * User-facing note attached to "this attachment is gone" states. A 404 can
 * mean the 14-day message-attachment retention sweep reclaimed the bytes, the
 * 24-hour orphan cleanup removed them, or they were released explicitly — the
 * UI cannot tell which, so the copy says "expired or unavailable" and states
 * the retention window without asserting which cleanup ran.
 */
export const ATTACHMENT_RETENTION_NOTE = `Cloud message attachments are retained for ${MESSAGE_ATTACHMENT_RETENTION_DAYS} days`;

/** True when the attachment row is gone server-side (reclaimed or deleted). */
export function isAttachmentGoneError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * Resolve a chat image reference to a renderable `data:` URL.
 *
 * The per-browser IndexedDB cache is consulted first (the sender's own sends,
 * and any already-rendered thumbnail, warm it); on a miss the bytes are fetched
 * from the org attachment store and the cache is warmed for next time. The
 * returned bytes are full-resolution — the same URL a thumbnail and the
 * lightbox both use, so opening the lightbox on an already-visible image
 * resolves from the warm cache (a fast IndexedDB read, no network refetch).
 *
 * Shared by the inline thumbnail ({@link ImageFromRef}) and the lightbox so the
 * two never drift on caching / fetch behaviour.
 *
 * `gone` means the server answered 404 — the attachment row no longer exists
 * (message attachments are retained for 14 days). Cached hits never reach the
 * network, so an already-downloaded image keeps rendering even after the row
 * is reclaimed.
 */
export type ImageSrcState = { kind: "loading" } | { kind: "hit"; src: string } | { kind: "miss" } | { kind: "gone" };

export function useImageSrc(imageId: string | undefined): ImageSrcState {
  const [state, setState] = useState<ImageSrcState>({ kind: "loading" });

  useEffect(() => {
    if (!imageId) {
      setState({ kind: "miss" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      const hit = await getImage(imageId);
      if (cancelled) return;
      if (hit) {
        setState({ kind: "hit", src: `data:${hit.mimeType};base64,${hit.base64}` });
        return;
      }
      try {
        const fetched = await fetchAttachmentBase64(imageId);
        if (cancelled) return;
        // Warm the cache for subsequent renders; best-effort.
        putImage({ imageId, base64: fetched.base64, mimeType: fetched.mimeType }).catch(() => {});
        setState({ kind: "hit", src: `data:${fetched.mimeType};base64,${fetched.base64}` });
      } catch (error) {
        if (!cancelled) setState({ kind: isAttachmentGoneError(error) ? "gone" : "miss" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageId]);

  return state;
}
