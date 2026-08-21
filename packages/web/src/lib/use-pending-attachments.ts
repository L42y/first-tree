import { type AttachmentKind, classifyComposerUpload, MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export type PendingAttachment = {
  id: string;
  file: File;
  /** Classification driving render + the sent ref's `kind`. */
  kind: AttachmentKind;
  /**
   * Object-URL for the thumbnail — present only for `kind: "image"`; documents
   * render as a {@link FileChip} with no preview. Revoked on remove / clear /
   * unmount when set.
   */
  previewUrl?: string;
};

export type PendingAttachmentSeed = Pick<PendingAttachment, "file" | "kind">;

export type UsePendingAttachments = {
  pendingAttachments: PendingAttachment[];
  /** Classify, validate, and stage the given files. Disallowed types and
   * oversized files are rejected via `onError`; nothing is staged for them. */
  addFiles: (files: File[]) => void;
  removeAttachment: (id: string) => void;
  /** Revoke any staged previews and empty the list (call after a send). */
  clearAttachments: () => void;
  /**
   * Re-stage previously-cleared files after a failed send — fresh ids and
   * fresh preview URLs (the originals were revoked on clear). No-op when
   * the user already staged replacements in the meantime.
   */
  restoreAttachments: (attachments: readonly PendingAttachmentSeed[]) => void;
};

const MAX_MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;

/**
 * Stages attachments for an outbound message — the shared backbone of the
 * in-chat composer, the new-chat draft, and the ask overlay, so they enforce
 * identical rules: the {@link classifyComposerUpload} allowlist (images +
 * text-native + office documents; archives / executables / media rejected) and
 * the shared `MAX_ATTACHMENT_BYTES` cap that the attachment upload route also
 * enforces. Images additionally carry a revocable object-URL preview.
 *
 * The host owns the actual upload + send; this hook only classifies, validates,
 * and holds the `File`s.
 *
 *   - `onError` surfaces a validation failure (unsupported type / oversized) to
 *     the host's own error channel.
 *   - `onChange` fires after any successful add/remove so the host can dismiss a
 *     now-stale error ("user is fixing it").
 *
 * Callbacks are read through a ref so the returned actions keep stable
 * identities regardless of what the caller passes inline.
 */
export function usePendingAttachments(
  opts: {
    onError?: (message: string) => void;
    onChange?: () => void;
    /** Restore already-validated files when a request-scoped draft remounts. */
    initialAttachments?: readonly PendingAttachmentSeed[];
  } = {},
): UsePendingAttachments {
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>(() =>
    (opts.initialAttachments ?? []).map(({ file, kind }) => ({
      id: crypto.randomUUID(),
      file,
      kind,
      ...(kind === "image" && typeof URL.createObjectURL === "function"
        ? { previewUrl: URL.createObjectURL(file) }
        : {}),
    })),
  );

  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  // Mirror the latest staged list so unmount cleanup can revoke any image
  // previews the user never sent or removed; without this those object-URLs
  // leak until page unload.
  const attachmentsRef = useRef(pendingAttachments);
  useEffect(() => {
    attachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);
  useEffect(() => {
    return () => {
      for (const a of attachmentsRef.current) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    };
  }, []);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;

    const staged: PendingAttachment[] = [];
    const rejectedTypes: string[] = [];
    let oversized: File | null = null;

    for (const file of files) {
      const { allowed, kind } = classifyComposerUpload(file.type, file.name);
      if (!allowed) {
        rejectedTypes.push(file.name);
        continue;
      }
      // Gate on the shared attachment byte cap: it's the binding limit for our
      // path — a file the composer accepts is one the upload route stores, and
      // it reaches the agent as an on-disk file read via its Read tool, so the
      // raw-byte storage cap governs rather than any model context limit.
      if (file.size > MAX_ATTACHMENT_BYTES) {
        oversized = file;
        break;
      }
      staged.push({
        id: crypto.randomUUID(),
        file,
        kind,
        ...(kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
      });
    }

    if (oversized) {
      // Revoke previews created for files staged earlier in this same batch
      // before we bail — the whole add is rejected, so none should leak.
      for (const a of staged) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      optsRef.current.onError?.(
        `File too large (${(oversized.size / 1024 / 1024).toFixed(1)}MB). Maximum ${MAX_MB}MB per file.`,
      );
      return;
    }
    if (rejectedTypes.length > 0 && staged.length === 0) {
      optsRef.current.onError?.(`Unsupported file type: ${rejectedTypes.join(", ")}`);
      return;
    }
    if (staged.length === 0) return;

    setPendingAttachments((prev) => [...prev, ...staged]);
    optsRef.current.onChange?.();
    if (rejectedTypes.length > 0) {
      optsRef.current.onError?.(`Unsupported file type: ${rejectedTypes.join(", ")}`);
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const a = prev.find((x) => x.id === id);
      if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
    optsRef.current.onChange?.();
  }, []);

  const clearAttachments = useCallback(() => {
    setPendingAttachments((prev) => {
      for (const a of prev) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      return [];
    });
  }, []);

  const restoreAttachments = useCallback((attachments: readonly PendingAttachmentSeed[]) => {
    if (attachments.length === 0) return;
    // Re-stage after a failed send with FRESH ids and fresh preview URLs —
    // the originals were revoked by clearAttachments, so reusing them would
    // dangle. A no-op when the user already staged replacements during the
    // in-flight window (reads the latest state inside the setter).
    // Deliberately does NOT fire onChange: this is a programmatic failure
    // rollback, not a user edit — the send error must stay visible.
    setPendingAttachments((current) => {
      if (current.length > 0) return current;
      return attachments.map(({ file, kind }) => ({
        id: crypto.randomUUID(),
        file,
        kind,
        ...(kind === "image" && typeof URL.createObjectURL === "function"
          ? { previewUrl: URL.createObjectURL(file) }
          : {}),
      }));
    });
  }, []);

  return { pendingAttachments, addFiles, removeAttachment, clearAttachments, restoreAttachments };
}
