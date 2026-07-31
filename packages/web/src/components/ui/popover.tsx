import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils.js";

type PopoverState = { open: boolean; toggle: () => void; close: () => void };

const VIEWPORT_MARGIN = 8;
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

type PopoverProps = {
  trigger: (state: PopoverState) => ReactNode;
  children: (state: { close: () => void }) => ReactNode;
  /** Where the popover anchors relative to the trigger. `end` right-aligns. */
  align?: "start" | "end";
  /** Pixel gap between trigger and panel. Default 4. */
  offset?: number;
  /** Optional className applied to the popover panel. */
  panelClassName?: string;
  /** Optional inline style applied to the popover panel. */
  panelStyle?: React.CSSProperties;
  /** Optional className applied to the trigger wrapper. */
  className?: string;
  /** Accessible name announced for the dialog panel. */
  panelAriaLabel?: string;
  /** Move focus to the first interactive control when the panel opens. */
  focusOnOpen?: boolean;
};

/**
 * Generic anchored popover primitive. Renders via React portal so an
 * `overflow: hidden` ancestor (the workspace rail) can't clip the panel.
 * Click-outside (across the trigger / panel pair) and Escape close it;
 * the panel is `position: fixed` and reanchors on each open.
 *
 * Trigger and content are render-props so callers can fully style the
 * trigger button (active state, count badges, focus rings) while still
 * sharing the open/close mechanics. Content receives `close` for actions
 * that dismiss the popover without taking focus away from their next target.
 * Escape is the dismissal path that restores focus to the trigger.
 */
export function Popover({
  trigger,
  children,
  align = "start",
  offset = 4,
  panelClassName,
  panelStyle,
  className,
  panelAriaLabel,
  focusOnOpen = false,
}: PopoverProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Position is recomputed every time the popover opens so a layout
  // shift (sidebar resize, keyboard appearing on mobile, etc) between
  // mounts doesn't anchor the next open onto stale coordinates.
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxHeight: number | undefined;
    maxWidth: number | undefined;
  }>({
    top: 0,
    left: 0,
    maxHeight: undefined,
    maxWidth: undefined,
  });

  const focusTrigger = useCallback((): void => {
    triggerRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
  }, []);
  const close = useCallback((): void => {
    setOpen(false);
  }, []);
  const closeAndRestoreFocus = useCallback((): void => {
    setOpen(false);
    window.setTimeout(focusTrigger, 0);
  }, [focusTrigger]);
  const toggle = (): void => setOpen((v) => !v);

  const computePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const rect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
    const viewportTop = window.visualViewport?.offsetTop ?? 0;
    const panelWidth = panelRect.width || panel.offsetWidth;
    const panelHeight = panelRect.height || panel.offsetHeight;
    const below = viewportTop + viewportHeight - rect.bottom - offset - VIEWPORT_MARGIN;
    const above = rect.top - viewportTop - offset - VIEWPORT_MARGIN;
    const openUp = panelHeight > below && above > below;
    const availableHeight = Math.max(0, openUp ? above : below);
    const renderedHeight = Math.min(panelHeight, availableHeight);
    const desiredLeft = align === "start" ? rect.left : rect.right - panelWidth;
    const minLeft = viewportLeft + VIEWPORT_MARGIN;
    const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - panelWidth - VIEWPORT_MARGIN);
    const left = Math.max(minLeft, Math.min(desiredLeft, maxLeft));
    const top = openUp
      ? Math.max(viewportTop + VIEWPORT_MARGIN, rect.top - offset - renderedHeight)
      : Math.min(rect.bottom + offset, viewportTop + viewportHeight - VIEWPORT_MARGIN - renderedHeight);

    setPosition({
      top,
      left,
      maxHeight: availableHeight,
      maxWidth: Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2),
    });
  }, [align, offset]);

  // Anchor the panel under the trigger. `useLayoutEffect` so the panel
  // never flashes at (0,0) before snapping into place on first paint.
  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
  }, [open, computePosition]);

  // Outside click + Escape + viewport reflow. Bound only while open so a
  // closed popover doesn't pay the global listener cost.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeAndRestoreFocus();
    };
    let frame = 0;
    const onReflow = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        computePosition();
      });
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    window.visualViewport?.addEventListener("scroll", onReflow);
    window.visualViewport?.addEventListener("resize", onReflow);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      window.visualViewport?.removeEventListener("scroll", onReflow);
      window.visualViewport?.removeEventListener("resize", onReflow);
    };
  }, [open, closeAndRestoreFocus, computePosition]);

  useEffect(() => {
    if (!open || !focusOnOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      (panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? panel).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, focusOnOpen]);

  return (
    <>
      <span ref={triggerRef} className={cn("inline-flex", className)}>
        {trigger({ open, toggle, close })}
      </span>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={panelAriaLabel}
            tabIndex={focusOnOpen ? -1 : undefined}
            className={cn("z-50", panelClassName)}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              maxHeight: position.maxHeight,
              maxWidth: position.maxWidth,
              overflowY: "auto",
              background: "var(--bg-raised)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-panel)",
              boxShadow: "var(--shadow-md)",
              ...panelStyle,
            }}
          >
            {children({ close })}
          </div>,
          document.body,
        )}
    </>
  );
}
