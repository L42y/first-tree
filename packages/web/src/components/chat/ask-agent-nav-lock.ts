import { useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router";

/**
 * Ask agent navigation lock.
 *
 * A pending Ask agent attempt — sending the clarification, or waiting for the
 * agent's durable reply — is owned by whichever review surface is mounted:
 * the Need you page or the Chat takeover. The attempt state lives inside the
 * component-local `useAskAgent` hook, so any navigation that unmounts the
 * owning surface (a desktop rail row, the mobile bottom tabs, browser back)
 * silently drops the waiting / timeout feedback. This module is the shared
 * source of truth that lets the navigation boundaries ABOVE those surfaces
 * fail closed for the bounded lifetime of the attempt. The lock lifts when
 * the attempt ends (reply, timeout, failure) or the surface unmounts for a
 * permitted reason, and navigation resumes.
 */

export type AskAgentNavLock = {
  chatId: string;
  requestId: string;
};

let locks: ReadonlyMap<string, AskAgentNavLock> = new Map();
const listeners = new Set<() => void>();

function keyOf(lock: AskAgentNavLock): string {
  return `${lock.chatId} ${lock.requestId}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function addAskAgentNavLock(lock: AskAgentNavLock): void {
  const key = keyOf(lock);
  if (locks.has(key)) return;
  const next = new Map(locks);
  next.set(key, lock);
  locks = next;
  emit();
}

export function removeAskAgentNavLock(lock: AskAgentNavLock): void {
  const key = keyOf(lock);
  if (!locks.has(key)) return;
  const next = new Map(locks);
  next.delete(key);
  locks = next;
  emit();
}

/** Test-only reset; production locks clear themselves on unlock/unmount. */
export function clearAskAgentNavLocks(): void {
  if (locks.size === 0) return;
  locks = new Map();
  emit();
}

/** Imperative read for navigation callbacks (always current, no closure staleness). */
export function isAskAgentNavLocked(): boolean {
  return locks.size > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hook-independent subscription, primarily for tests and non-React guards. */
export function subscribeAskAgentNavLock(listener: () => void): () => void {
  return subscribe(listener);
}

/** Reactive "an Ask agent attempt is pending" flag for navigation boundaries. */
export function useAskAgentNavLocked(): boolean {
  return useSyncExternalStore(subscribe, isAskAgentNavLocked, () => false);
}

/**
 * Mounted once by each navigation shell (desktop Workspace, mobile shell).
 * While an attempt is pending, this remembers the owning surface's URL and
 * history index, and installs a CAPTURE-phase popstate interceptor. The
 * capture listener fires before React Router's bubble-phase `popstate`
 * handler, so on browser Back/Forward it can `stopImmediatePropagation()` —
 * the router never commits the exit, the owning surface never unmounts, and
 * the attempt lock (whose cleanup runs on unmount) stays held. The address
 * bar is then restored to the locked entry: `history.state.idx` arithmetic
 * gives the exact signed direction with no sentinel entries and no bounce —
 * the restore hop lands precisely on the locked index, where the follow-up
 * event is a no-op. `stopImmediatePropagation` also keeps the restore single
 * if several shells ever listen at once. When the attempt lifts, the
 * listener is removed and Back/Forward work normally again. In-app exits are
 * fail-closed at their own callbacks instead (rail rows, tab bar, list back).
 * Returns the reactive locked flag so those boundaries can also render a
 * disabled state.
 */
export function useAskAgentNavGuard(): boolean {
  const locked = useAskAgentNavLocked();
  const location = useLocation();
  const lockedEntryRef = useRef<{ url: string; idx: number | null } | null>(null);
  const wasLockedRef = useRef(false);

  useEffect(() => {
    if (locked && !wasLockedRef.current) {
      lockedEntryRef.current = {
        url: `${location.pathname}${location.search}${location.hash}`,
        idx: readHistoryIdx(window.history.state),
      };
    } else if (!locked && wasLockedRef.current) {
      lockedEntryRef.current = null;
    }
    wasLockedRef.current = locked;
  }, [locked, location]);

  useEffect(() => {
    if (!locked) return;
    const onPopState = (event: PopStateEvent) => {
      // Imperative read: the lock may have lifted between URL capture and
      // this pop — never trap the user on a stale surface.
      if (!isAskAgentNavLocked()) return;
      const target = lockedEntryRef.current;
      if (!target) return;
      event.stopImmediatePropagation();
      const currentIdx = readHistoryIdx(event.state);
      if (target.idx !== null && currentIdx !== null) {
        const delta = target.idx - currentIdx;
        if (delta !== 0) window.history.go(delta);
      } else {
        // No index bookkeeping (foreign entry): at least pin the address bar
        // back to the locked URL — the router never processed the exit.
        window.history.replaceState(window.history.state, "", target.url);
      }
    };
    window.addEventListener("popstate", onPopState, true);
    return () => window.removeEventListener("popstate", onPopState, true);
  }, [locked]);

  return locked;
}

function readHistoryIdx(state: unknown): number | null {
  if (state && typeof state === "object" && typeof (state as { idx?: unknown }).idx === "number") {
    return (state as { idx: number }).idx;
  }
  return null;
}
