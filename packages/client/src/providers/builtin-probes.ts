import {
  type CapabilityEntry,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProvider,
} from "@first-tree/shared";
import { probeClaudeCodeCapability } from "../runtime/capabilities/claude-code.js";
import { probeClaudeCodeTuiCapability } from "../runtime/capabilities/claude-code-tui.js";
import { probeCodexCapability } from "../runtime/capabilities/codex.js";
import { probeCursorCapability } from "../runtime/capabilities/cursor.js";
import { probeGrokCapability } from "../runtime/capabilities/grok.js";
import { probeKimiCodeCapability } from "../runtime/capabilities/kimi-code.js";
import { probeOpenCodeCapability } from "../runtime/capabilities/opencode.js";
import { probePiCapability } from "../runtime/capabilities/pi.js";

export type CapabilityProbe = () => Promise<CapabilityEntry>;

/**
 * Exhaustive install-probe table for built-in providers.
 *
 * Kept separate from handler factories so capability aggregation can stay free
 * of concrete handler / SDK imports while still sharing the same provider set
 * as the composition registry.
 */
export const BUILTIN_PROVIDER_PROBES = {
  "claude-code": probeClaudeCodeCapability,
  "claude-code-tui": probeClaudeCodeTuiCapability,
  codex: probeCodexCapability,
  cursor: probeCursorCapability,
  grok: probeGrokCapability,
  "kimi-code": probeKimiCodeCapability,
  opencode: probeOpenCodeCapability,
  pi: probePiCapability,
} as const satisfies Record<RuntimeProvider, CapabilityProbe>;

export type BuiltinProviderProbeTable = Readonly<Record<RuntimeProvider, CapabilityProbe>>;

/** Optional process-wide probe-table override for tests. */
let installedProbes: BuiltinProviderProbeTable | null = null;

export function installBuiltinProviderProbes(probes: BuiltinProviderProbeTable): void {
  installedProbes = probes;
}

export function getBuiltinProviderProbes(): BuiltinProviderProbeTable {
  return installedProbes ?? BUILTIN_PROVIDER_PROBES;
}

export function resetBuiltinProviderProbesForTests(): void {
  installedProbes = null;
}

export function builtinProbeProviderIds(
  probes: BuiltinProviderProbeTable = getBuiltinProviderProbes(),
): RuntimeProvider[] {
  return RUNTIME_PROVIDER_IDS.filter((id) => id in probes);
}

/** Enabled providers that have a built-in probe (drives daemon re-probe loops). */
export function probedRuntimeProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDER_IDS.filter((id) => isRuntimeProviderEnabled(id));
}
