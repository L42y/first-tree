import {
  type CapabilityEntry,
  type ClientCapabilities,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProvider,
} from "@first-tree/shared";
import {
  BUILTIN_PROVIDER_PROBES,
  type BuiltinProviderProbeTable,
  probedRuntimeProviders,
} from "../../providers/builtin-probes.js";

/** Periodic full re-probe ceiling: re-detect at most this often on reconnect to
 * catch silent drift (a provider uninstalled while connected). Detection is
 * cheap (no launch), so this is a coarse staleness bound, not a cost guard. */
export const REPROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The runtime providers a built-in probe exists for AND that are not
 * temporarily disabled. Drives whether a daemon's advertised snapshot still has
 * a provider worth re-probing (see {@link hasNonOkProvider}). */
export const PROBED_RUNTIME_PROVIDERS: readonly RuntimeProvider[] = probedRuntimeProviders();

/** First delay before the daemon-side degraded-capability re-probe fires. Short
 * enough that a freshly-installed provider is noticed quickly during setup. */
export const CAPABILITY_REFRESH_BASE_MS = 15 * 1000;

/** Upper bound on the backoff between degraded-capability re-probes. */
export const CAPABILITY_REFRESH_MAX_MS = 5 * 60 * 1000;

/**
 * True when the snapshot still has a built-in provider that is not `ok` — i.e.
 * a provider that could still become installed if the operator installs it. An
 * empty or partial snapshot counts as degraded. Drives whether the daemon keeps
 * a background re-probe scheduled while it stays connected.
 */
export function hasNonOkProvider(caps: ClientCapabilities): boolean {
  return PROBED_RUNTIME_PROVIDERS.some((provider) => caps[provider]?.state !== "ok");
}

/**
 * Exponential backoff for the degraded-capability re-probe loop:
 * `base * 2^attempt`, clamped to `max`.
 */
export function nextCapabilityRefreshDelayMs(attempt: number, opts: { baseMs?: number; maxMs?: number } = {}): number {
  const baseMs = opts.baseMs ?? CAPABILITY_REFRESH_BASE_MS;
  const maxMs = opts.maxMs ?? CAPABILITY_REFRESH_MAX_MS;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const exponent = Math.min(safeAttempt, 30);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

function errorEntry(err: unknown): CapabilityEntry {
  return {
    state: "error",
    available: false,
    error: err instanceof Error ? err.message : String(err),
    detectedAt: new Date().toISOString(),
  };
}

async function aggregate(
  probes: Array<readonly [RuntimeProvider, Promise<CapabilityEntry>]>,
): Promise<ClientCapabilities> {
  // Settle concurrently, then publish in the input/provider order. Writing
  // into `out` inside each async branch would make capability-map insertion
  // order depend on probe completion timing, which agent-creation surfaces
  // intentionally preserve after their explicit Codex/Claude preference.
  const settled = await Promise.all(
    probes.map(async ([provider, p]) => {
      try {
        return [provider, await p] as const;
      } catch (err) {
        return [provider, errorEntry(err)] as const;
      }
    }),
  );

  const out: ClientCapabilities = {};
  for (const [provider, entry] of settled) out[provider] = entry;
  return out;
}

export type ProbeCapabilitiesOptions = {
  /**
   * Explicit probe table injection for tests. Production callers omit this and
   * use the immutable {@link BUILTIN_PROVIDER_PROBES} composition table.
   */
  probes?: BuiltinProviderProbeTable;
};

/**
 * Run every built-in install probe and aggregate the results.
 *
 * Probe callbacks come from explicit `probes` or the immutable composition
 * table. This orchestrator must not import or switch on concrete provider
 * modules. Detection is install-only — no binary is launched.
 */
export async function probeCapabilities(options: ProbeCapabilitiesOptions = {}): Promise<ClientCapabilities> {
  const probeTable = options.probes ?? BUILTIN_PROVIDER_PROBES;
  const probes: Array<readonly [RuntimeProvider, Promise<CapabilityEntry>]> = [];
  for (const provider of RUNTIME_PROVIDER_IDS) {
    if (!isRuntimeProviderEnabled(provider)) continue;
    probes.push([provider, probeTable[provider]()]);
  }
  return aggregate(probes);
}

/**
 * Whether a reconnect should re-detect. Detection is cheap (no launch / no
 * token spend), so a reconnect always re-detects via {@link probeCapabilities}
 * — `revalidateCapabilities` is kept as an alias so the connected-poll caller
 * (`CapabilityRefresher`) keeps a stable surface. `shouldFullReprobe` is
 * retained for callers that log which path ran; an empty or stale snapshot
 * always re-detects.
 */
export function shouldFullReprobe(
  previous: ClientCapabilities,
  now: number,
  maxAgeMs: number = REPROBE_MAX_AGE_MS,
): boolean {
  const entries = Object.values(previous).filter((e): e is CapabilityEntry => e != null);
  if (entries.length === 0) return true;
  return entries.some((e) => {
    const at = Date.parse(e.detectedAt);
    return Number.isNaN(at) || now - at > maxAgeMs;
  });
}

/**
 * Re-detect all providers. With install-only detection there is no expensive
 * smoke to preserve, so a revalidate is simply a fresh detection sweep.
 */
export async function revalidateCapabilities(_previous: ClientCapabilities): Promise<ClientCapabilities> {
  return probeCapabilities();
}

/**
 * Capability refresh for a WS reconnect. Detection is cheap, so this always
 * re-detects; `mode` is reported for log parity with the previous two-path
 * (full vs revalidate) design.
 */
export async function reprobeOnReconnect(
  _previous: ClientCapabilities,
  _opts: { now?: number; maxAgeMs?: number } = {},
): Promise<{ capabilities: ClientCapabilities; mode: "full" | "revalidate" }> {
  return { capabilities: await probeCapabilities(), mode: "full" };
}
