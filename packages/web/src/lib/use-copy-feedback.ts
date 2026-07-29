import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Default duration of the transient "Copied" / "Copy failed" feedback window.
 * Sites that need a different window pass `feedbackMs` instead of redefining
 * their own constant.
 */
export const COPY_FEEDBACK_MS = 1_500;

export type CopyFeedbackStatus = "idle" | "copied" | "failed";

/**
 * Copy-to-clipboard with transient button feedback — the single source of
 * truth for the copy → "Copied" pattern that used to be hand-rolled per
 * call site (issue 999).
 *
 * Contract (modeled on the most robust of the previous copies):
 *  - `copy(text)` writes to the clipboard, returns the resulting status, and
 *    flips `status` to `"copied"`, or to `"failed"` when
 *    `navigator.clipboard.writeText` rejects (non-secure context, or the user
 *    denied the clipboard permission) — callers decide whether to surface the
 *    failed state or treat it as idle.
 *  - One reset timer, clear-before-set: a rapid second copy restarts the full
 *    feedback window instead of being cut short by the first timer.
 *  - The timer is cleared on unmount, so no state update fires after the
 *    owning component is gone.
 */
export function useCopyFeedback(options?: { feedbackMs?: number }): {
  status: CopyFeedbackStatus;
  copy: (text: string) => Promise<CopyFeedbackStatus>;
  /** Snap back to idle immediately (e.g. when a host dialog reopens). */
  reset: () => void;
} {
  const feedbackMs = options?.feedbackMs ?? COPY_FEEDBACK_MS;
  const [status, setStatus] = useState<CopyFeedbackStatus>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operation = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const copy = useCallback(
    async (text: string): Promise<CopyFeedbackStatus> => {
      const currentOperation = ++operation.current;
      let next: CopyFeedbackStatus;
      try {
        await navigator.clipboard.writeText(text);
        next = "copied";
      } catch {
        next = "failed";
      }
      if (!mounted.current || operation.current !== currentOperation) return "idle";
      setStatus(next);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setStatus("idle"), feedbackMs);
      return next;
    },
    [feedbackMs],
  );

  const reset = useCallback((): void => {
    operation.current += 1;
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = null;
    if (mounted.current) setStatus("idle");
  }, []);

  return { status, copy, reset };
}
