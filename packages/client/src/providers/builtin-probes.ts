import {
  type CapabilityEntry,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProvider,
} from "@first-tree/shared";
import { probeOpenCodeCapability } from "../runtime/capabilities/opencode.js";
import { probePiCapability } from "../runtime/capabilities/pi.js";
import { probeClaudeCodeCapability } from "./claude/capability.js";
import { probeClaudeCodeTuiCapability } from "./claude/capability-tui.js";
import { probeCodexCapability } from "./codex/capability.js";
import { probeCursorCapability } from "./cursor/capability.js";
import { probeGrokCapability } from "./grok/capability.js";
import { probeKimiCodeCapability } from "./kimi-code/capability.js";

export type CapabilityProbe = () => Promise<CapabilityEntry>;

export type BuiltinProviderProbeTable = Readonly<Record<RuntimeProvider, CapabilityProbe>>;

/**
 * Frozen install-probe table for built-in providers.
 *
 * Composition-owned projection of the exhaustive provider set. Capability
 * aggregation reads this table directly (or an explicit `{ probes }` inject)
 * so the probe path does not pull handler/SDK imports.
 */
export const BUILTIN_PROVIDER_PROBES: BuiltinProviderProbeTable = Object.freeze({
  "claude-code": probeClaudeCodeCapability,
  "claude-code-tui": probeClaudeCodeTuiCapability,
  codex: probeCodexCapability,
  cursor: probeCursorCapability,
  grok: probeGrokCapability,
  "kimi-code": probeKimiCodeCapability,
  opencode: probeOpenCodeCapability,
  pi: probePiCapability,
} satisfies Record<RuntimeProvider, CapabilityProbe>);

/** Enabled providers that have a built-in probe (drives daemon re-probe loops). */
export function probedRuntimeProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDER_IDS.filter((id) => isRuntimeProviderEnabled(id));
}
