import type { ContextSource } from "./context-source.js";

/**
 * Re-resolve source authority before a new provider admission. A prior
 * Remote is not a lease and therefore does not short-circuit this read.
 * Resolution failures propagate so callers can preserve LKG and block the
 * admission instead of silently starting from stale coordinates.
 */
export async function reresolveContextSource(
  _current: { kind?: unknown; path?: unknown },
  resolve: () => Promise<ContextSource>,
): Promise<ContextSource | null> {
  return resolve();
}

/**
 * @deprecated Use {@link reresolveContextSource}. Kept for tests that still
 * pass a remote-only resolver.
 */
export async function reresolveUnboundTree(
  currentPath: unknown,
  resolve: () => Promise<{ path: string; repoUrl: string; branch: string } | null>,
): Promise<{ path: string; repoUrl: string; branch: string } | null> {
  const source = await reresolveContextSource({ path: currentPath }, async () => {
    const binding = await resolve();
    if (!binding) return { kind: "none", reason: "unknown" };
    return { kind: "remote", path: binding.path, repoUrl: binding.repoUrl, branch: binding.branch };
  });
  if (source?.kind !== "remote") return null;
  return { path: source.path, repoUrl: source.repoUrl, branch: source.branch };
}
