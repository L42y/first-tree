import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { downloadAttachment } from "../../api/attachments.js";
import { ATTACHMENT_RETENTION_NOTE, isAttachmentGoneError, useImageSrc } from "../../lib/use-image-src.js";
import { useToast } from "./toast.js";

/**
 * One image in a lightbox set. Either an `imageId` (resolved from the org
 * attachment store / IndexedDB cache — full resolution, usually already warm
 * from the thumbnail) or a ready `dataSrc` (inline base64 sends, which carry
 * no attachment row).
 */
export type LightboxImage = {
  imageId?: string;
  dataSrc?: string;
  filename: string;
};

// Control offsets keep clear of notch / home-indicator safe areas on mobile
// (the chat surface — and this lightbox — is shared with the mobile app).
const TOP = "calc(var(--sp-4) + env(safe-area-inset-top))";
const RIGHT = "calc(var(--sp-4) + env(safe-area-inset-right))";
const BOTTOM = "calc(var(--sp-4) + env(safe-area-inset-bottom))";
const ARROW_LEFT = "calc(var(--sp-2) + env(safe-area-inset-left))";
const ARROW_RIGHT = "calc(var(--sp-2) + env(safe-area-inset-right))";

type ImageLightboxProps = {
  images: LightboxImage[];
  /** Index of the open image; `null` closes the lightbox. */
  index: number | null;
  onIndexChange: (index: number | null) => void;
};

/**
 * Full-screen image viewer for chat images. Built on the Radix Dialog
 * primitive (Escape / focus-trap / scroll-lock for free) but full-bleed:
 * the image fits the viewport, with close + download always available and
 * prev/next paging when the set has more than one image. Mobile inherits it
 * unchanged (the chat surface is shared).
 */
export function ImageLightbox({ images, index, onIndexChange }: ImageLightboxProps) {
  const open = index !== null && index >= 0 && index < images.length;
  const current = open ? images[index] : undefined;
  const multi = images.length > 1;
  const { addToast } = useToast();
  // Images whose row is gone server-side (404) report upward — via the view's
  // resolve state or a failed download on a warm-cache hit — so the Download
  // control disables instead of firing a request that is guaranteed to fail.
  const [goneIds, setGoneIds] = useState<ReadonlySet<string>>(new Set());
  const markGone = useCallback((imageId: string) => {
    setGoneIds((prev) => (prev.has(imageId) ? prev : new Set(prev).add(imageId)));
  }, []);
  const currentGone = current?.imageId !== undefined && goneIds.has(current.imageId);

  const close = useCallback(() => onIndexChange(null), [onIndexChange]);
  const step = useCallback(
    (delta: number) => {
      if (index === null) return;
      onIndexChange((index + delta + images.length) % images.length);
    },
    [index, images.length, onIndexChange],
  );

  const onDownload = useCallback(() => {
    if (!current) return;
    if (current.imageId) {
      const imageId = current.imageId;
      downloadAttachment(imageId, current.filename).catch((error: unknown) => {
        if (isAttachmentGoneError(error)) {
          markGone(imageId);
          addToast({
            title: `Couldn't download "${current.filename}"`,
            description: `Attachment expired or unavailable (${ATTACHMENT_RETENTION_NOTE}).`,
          });
          return;
        }
        addToast({
          title: "Download failed",
          description: `"${current.filename}" couldn't be downloaded. Try again.`,
        });
      });
      return;
    }
    if (current.dataSrc) {
      // Anchor must be in the document for a programmatic download click to
      // fire in some browsers (matches downloadAttachment's approach).
      const a = document.createElement("a");
      a.href = current.dataSrc;
      a.download = current.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }, [current, markGone, addToast]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-overlay-scrim data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (!multi) return;
            if (e.key === "ArrowLeft") step(-1);
            if (e.key === "ArrowRight") step(1);
          }}
          className="fixed inset-0 z-[80] flex items-center justify-center focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          // Click on the empty backdrop (not the image or a control) closes.
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <DialogPrimitive.Title className="sr-only">{current?.filename ?? "Image"}</DialogPrimitive.Title>

          {current ? <LightboxImageView key={index} image={current} onGone={markGone} /> : null}

          {/* Top-right: download + close */}
          {current ? (
            <div className="absolute flex items-center gap-2" style={{ top: TOP, right: RIGHT }}>
              <button
                type="button"
                onClick={onDownload}
                disabled={currentGone}
                aria-label="Download original"
                title={currentGone ? `Attachment expired or unavailable (${ATTACHMENT_RETENTION_NOTE}).` : undefined}
                className="lightbox-control flex h-9 w-9 items-center justify-center rounded-[var(--radius-input)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="lightbox-control flex h-9 w-9 items-center justify-center rounded-[var(--radius-input)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          ) : null}

          {current && multi ? (
            <>
              <button
                type="button"
                onClick={() => step(-1)}
                aria-label="Previous image"
                className="lightbox-control absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full"
                style={{ left: ARROW_LEFT }}
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                aria-label="Next image"
                className="lightbox-control absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full"
                style={{ right: ARROW_RIGHT }}
              >
                <ChevronRight className="h-6 w-6" />
              </button>
              <div
                aria-live="polite"
                className="lightbox-chip mono text-caption absolute left-1/2 -translate-x-1/2 rounded-full px-3 py-1"
                style={{ bottom: BOTTOM }}
              >
                {(index ?? 0) + 1} / {images.length}
              </div>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The current image inside the lightbox. Resolves its own `src` (inline
 * `dataSrc`, else fetched-and-cached by `imageId`) so it can be re-keyed per
 * index without threading resolution state up. Fits the viewport; never
 * upscaled past its natural size.
 */
function LightboxImageView({ image, onGone }: { image: LightboxImage; onGone?: (imageId: string) => void }) {
  const refState = useImageSrc(image.dataSrc ? undefined : image.imageId);
  const src = image.dataSrc ?? (refState.kind === "hit" ? refState.src : undefined);

  useEffect(() => {
    if (refState.kind === "gone" && image.imageId) onGone?.(image.imageId);
  }, [refState.kind, image.imageId, onGone]);

  if (!src) {
    return (
      <span className="text-body" style={{ color: "var(--fg-on-vivid)" }}>
        {refState.kind === "gone"
          ? `"${image.filename}" expired or unavailable — ${ATTACHMENT_RETENTION_NOTE}`
          : refState.kind === "miss"
            ? `Couldn't load "${image.filename}"`
            : "…"}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={image.filename}
      className="rounded-[var(--radius-dialog)]"
      style={{ maxWidth: "92vw", maxHeight: "85vh", objectFit: "contain" }}
    />
  );
}
