import type { ContextTreeBindingResolution } from "./bootstrap.js";

/**
 * Lazily re-resolve an agent's Context Tree binding when it started its slot
 * tree-LESS.
 *
 * The binding is resolved once at `AgentSlot.start()` and frozen into the
 * handler config for the slot's lifetime. That's wrong for the new-tree
 * onboarding flow: the agent's slot comes up before the org's `context_tree`
 * setting exists (the kickoff step provisions it moments later), so the slot is
 * frozen tree-less and would never pick up the tree until a daemon restart.
 *
 * This decides whether a fresh re-resolution is warranted at session start:
 *   - already bound (`currentPath` is a non-empty string) → returns null and
 *     does NOT call `resolve`, so the steady-state path pays nothing;
 *   - unbound → calls `resolve` once and returns whatever it produced (the
 *     full tri-state resolution: a fresh binding, an explicit unbind, or an
 *     unresolved state when the org still has no tree / the server is
 *     unreachable).
 *
 * Never throws — a failed re-resolution degrades to the `unresolved` status
 * for this turn (the next new session retries). The caller owns applying the
 * returned resolution to its (mutable) handler config, including tracking the
 * status so an explicitly-unbound agent that later gets bound is picked up
 * and a later unbind transition updates the recorded status.
 */
export async function reresolveUnboundTree(
  currentPath: unknown,
  resolve: () => Promise<ContextTreeBindingResolution>,
): Promise<ContextTreeBindingResolution | null> {
  if (typeof currentPath === "string" && currentPath.length > 0) return null;
  try {
    return await resolve();
  } catch {
    return { status: "unresolved" };
  }
}
