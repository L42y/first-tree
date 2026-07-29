import { useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";

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
 * reverts any popstate (browser back/forward) that would leave it. The
 * popstate event fires synchronously BEFORE React processes the location
 * change, so the restore lands while the lock is still held — the owning
 * surface never unmounts mid-attempt. In-app exits are fail-closed at their
 * own callbacks instead (rail rows, tab bar, list back). Returns the reactive
 * locked flag so those boundaries can also render a disabled state.
 */
export function useAskAgentNavGuard(): boolean {
  const locked = useAskAgentNavLocked();
  const navigate = useNavigate();
  const location = useLocation();
  const lockedUrlRef = useRef<string | null>(null);
  const wasLockedRef = useRef(false);

  useEffect(() => {
    if (locked && !wasLockedRef.current) {
      lockedUrlRef.current = `${location.pathname}${location.search}`;
    } else if (!locked && wasLockedRef.current) {
      lockedUrlRef.current = null;
    }
    wasLockedRef.current = locked;
  }, [locked, location]);

  useEffect(() => {
    if (!locked) return;
    const onPopState = () => {
      const url = lockedUrlRef.current;
      // Re-read the store at event time: a lock that lifted between the URL
      // capture and this pop navigation must not trap the user on a stale
      // surface.
      if (!url || !isAskAgentNavLocked()) return;
      navigate(url, { replace: true });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [locked, navigate]);

  return locked;
}
