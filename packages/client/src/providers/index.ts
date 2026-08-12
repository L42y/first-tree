/**
 * Provider composition surface — built-in registries, probes, skill roots, and
 * provider-family entry points. Production code under `providers/` must not
 * import Cloud observability; inject a narrow log seam at the composition edge.
 */
export type {
  RuntimeAuthDriver,
  RuntimeAuthLoginResolution,
  RuntimeAuthLoginStart,
  RuntimeAuthProbeResult,
} from "./auth-driver.js";
export type { RuntimeAuthDriverTable } from "./auth-drivers.js";
export { RUNTIME_AUTH_DRIVERS } from "./auth-drivers.js";
export type { BuiltinProviderProbeTable, CapabilityProbe } from "./builtin-probes.js";
export { BUILTIN_PROVIDER_PROBES, probedRuntimeProviders } from "./builtin-probes.js";
export type { BuiltinHandlerRegistry, BuiltinHandlerRegistryDeps, BuiltinRegistryLog } from "./builtin-registry.js";
export {
  createBuiltinHandlerRegistry,
  resolveAndLogClaudeExecutable,
} from "./builtin-registry.js";
export { PROVIDER_SKILL_ROOTS } from "./skill-roots.js";
