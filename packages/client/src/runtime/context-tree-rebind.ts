import type { ContextTreeBindingResolution } from "./bootstrap.js";

/**
 * Re-resolve an agent's Context Tree binding for a session admission.
 *
 * The binding is resolved once at `AgentSlot.start()` and frozen into the
 * handler config for the slot's lifetime. That's wrong whenever the org
 * `context_tree` setting changes after slot start: the new-tree onboarding
 * flow provisions the tree moments after the slot came up, and a later
 * explicit unbind or rebind in the Web must take effect without a daemon
 * restart. The caller rate-limits (one refresh per interval) and single-flights
 * these calls; this helper owns only the fail-closed contract:
 *
 * Never throws — a failed re-resolution degrades to the `unresolved` status
 * for this turn (the next admission retries after the interval). The caller
 * owns applying the returned resolution to its (mutable) handler config,
 * including clearing stale coordinates so an unbound or unconfirmable binding
 * is never exposed to provider/briefing from a previously-bound snapshot.
 */
export async function refreshContextTreeBinding(
  resolve: () => Promise<ContextTreeBindingResolution>,
): Promise<ContextTreeBindingResolution> {
  try {
    return await resolve();
  } catch {
    return { status: "unresolved" };
  }
}
