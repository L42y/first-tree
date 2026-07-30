import { useSyncExternalStore } from "react";

/**
 * Ask agent navigation lock.
 *
 * A pending Ask agent attempt — sending the clarification, or waiting for the
 * agent's durable reply — is owned by whichever review surface is mounted:
 * the Need you page or the Chat takeover. The attempt state lives inside the
 * component-local `useAskAgent` hook, so any navigation that unmounts the
 * owning surface (a desktop rail row, the mobile bottom tabs, a top-bar
 * control, browser Back/Forward) silently drops the waiting / timeout
 * feedback. This module is the shared source of truth that lets the
 * navigation boundaries ABOVE those surfaces fail closed for the bounded
 * lifetime of the attempt.
 *
 * Browser history ownership is enforced by a SINGLETON popstate listener
 * installed at bootstrap (`installAskAgentNavGuard`, called from `main.tsx`
 * BEFORE the React root renders). `popstate` fires AT the window target,
 * where listeners run in REGISTRATION ORDER — the capture flag does not
 * reorder at-target listeners (verified in real Chromium). Only a listener
 * registered before React Router's history listener can intercept a locked
 * pop; a later listener — capture or not — always arrives after the router
 * has already committed the exit and the owner cleanup has already removed
 * the lock. In-app exits are fail-closed at their own callbacks (rail rows,
 * tab bar, top-bar host controls); the singleton owns Back/Forward.
 */

export type AskAgentNavLock = {
  chatId: string;
  requestId: string;
};

type AskAgentNavTarget = {
  /** Full owning-surface URL — pathname + search + hash. */
  url: string;
  /** `history.state.idx` of the owning entry, when the entry carries one. */
  idx: number | null;
};

let locks: ReadonlyMap<string, AskAgentNavLock> = new Map();
let activeTarget: AskAgentNavTarget | null = null;
const listeners = new Set<() => void>();

function keyOf(lock: AskAgentNavLock): string {
  return `${lock.chatId} ${lock.requestId}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function readHistoryIdx(state: unknown): number | null {
  if (state && typeof state === "object" && typeof (state as { idx?: unknown }).idx === "number") {
    return (state as { idx: number }).idx;
  }
  return null;
}

function captureTarget(): AskAgentNavTarget {
  if (typeof window === "undefined") return { url: "", idx: null };
  return {
    url: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    idx: readHistoryIdx(window.history.state),
  };
}

export function addAskAgentNavLock(lock: AskAgentNavLock): void {
  const key = keyOf(lock);
  if (locks.has(key)) return;
  const next = new Map(locks);
  next.set(key, lock);
  locks = next;
  // Synchronous ownership: the FIRST lock pins the owning surface's URL and
  // history index at publish time — no React effect, no Router dependency,
  // so the singleton listener always has a target the moment it matters.
  // Later same-attempt locks do not move the target; the last removal
  // releases it.
  if (next.size === 1) activeTarget = captureTarget();
  emit();
}

export function removeAskAgentNavLock(lock: AskAgentNavLock): void {
  const key = keyOf(lock);
  if (!locks.has(key)) return;
  const next = new Map(locks);
  next.delete(key);
  locks = next;
  if (next.size === 0) activeTarget = null;
  emit();
}

/** Test-only reset; production locks clear themselves on unlock/unmount. */
export function clearAskAgentNavLocks(): void {
  if (locks.size === 0) return;
  locks = new Map();
  activeTarget = null;
  emit();
}

/** Imperative read for navigation callbacks (always current, no closure staleness). */
export function isAskAgentNavLocked(): boolean {
  return locks.size > 0;
}

/** The pinned owning-surface entry while any attempt is pending. */
export function getAskAgentNavTarget(): AskAgentNavTarget | null {
  return activeTarget;
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

function onAskAgentPopState(event: PopStateEvent): void {
  // Imperative reads: the attempt may have lifted between target capture and
  // this pop — never trap the user on a stale surface.
  if (!isAskAgentNavLocked()) return;
  const target = activeTarget;
  if (!target) return;
  // This listener is the EARLIEST-registered pop listener (bootstrap, before
  // React Router). Stopping the event here means the router never processes
  // a locked pop: no location commit, no owner unmount, no lock cleanup.
  event.stopImmediatePropagation();
  const currentIdx = readHistoryIdx(event.state);
  if (target.idx !== null && currentIdx !== null) {
    // Exact signed direction for BOTH Back and Forward, with no sentinel
    // entries and no bounce: the restore hop lands precisely on the locked
    // index, where the follow-up event is a no-op.
    const delta = target.idx - currentIdx;
    if (delta !== 0) window.history.go(delta);
  } else if (target.url) {
    // No index bookkeeping (foreign entry): at least pin the address bar
    // back to the locked URL — the router never processed the exit.
    window.history.replaceState(window.history.state, "", target.url);
  }
}

let installed = false;

/**
 * Install the singleton browser-history guard. MUST run before the React
 * root renders (see the module header for why registration order is the only
 * ordering that exists at the window target). Idempotent and SSR-safe.
 */
export function installAskAgentNavGuard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("popstate", onAskAgentPopState);
}

/** Test-only teardown: removes the singleton listener and resets all state. */
export function uninstallAskAgentNavGuardForTest(): void {
  if (installed && typeof window !== "undefined") {
    window.removeEventListener("popstate", onAskAgentPopState);
  }
  installed = false;
  clearAskAgentNavLocks();
}
