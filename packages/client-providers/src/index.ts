export type {
  RuntimeAuthDriver,
  RuntimeAuthLoginResolution,
  RuntimeAuthLoginStart,
  RuntimeAuthProbeResult,
} from "./providers/auth-driver.js";
export type { RuntimeAuthDriverTable } from "./providers/auth-drivers.js";
export { RUNTIME_AUTH_DRIVERS } from "./providers/auth-drivers.js";
export type { BuiltinProviderProbeTable, CapabilityProbe } from "./providers/builtin-probes.js";
export { BUILTIN_PROVIDER_PROBES, probedRuntimeProviders } from "./providers/builtin-probes.js";
export type {
  BuiltinHandlerRegistry,
  BuiltinHandlerRegistryDeps,
  BuiltinRegistryLog,
} from "./providers/builtin-registry.js";
export {
  createBuiltinHandlerRegistry,
  resolveAndLogClaudeExecutable,
} from "./providers/builtin-registry.js";
export {
  CAPABILITY_REFRESH_BASE_MS,
  CAPABILITY_REFRESH_MAX_MS,
  hasNonOkProvider,
  nextCapabilityRefreshDelayMs,
  PROBED_RUNTIME_PROVIDERS,
  probeCapabilities,
  REPROBE_MAX_AGE_MS,
  reprobeOnReconnect,
  revalidateCapabilities,
  shouldFullReprobe,
} from "./providers/capabilities/index.js";
// Capabilities
export { probeClaudeCodeCapability } from "./providers/claude/capability.js";
export { probeClaudeCodeTuiCapability } from "./providers/claude/capability-tui.js";
// Handlers
export { detectStreamApiError, StreamApiTransientError } from "./providers/claude/index.js";
export {
  type ClaudeAuthDriverDeps,
  type ClaudeBrowserLoginOptions,
  type ClaudeLoginInvocation,
  createClaudeAuthDriver,
  resolveClaudeLoginInvocation,
  runClaudeBrowserLogin,
} from "./providers/claude/login.js";
export {
  type CodexBinaryResolution,
  probeCodexCapability,
  resolveCodexRuntimeBinary,
} from "./providers/codex/capability.js";
export {
  type CodexAuthDriverDeps,
  type CodexBrowserLoginOptions,
  createCodexAuthDriver,
  runCodexBrowserLogin,
} from "./providers/codex/login.js";
export {
  CURSOR_INSTALL_COMMAND,
  type CursorRuntimeBinaryResolution,
  findCursorExecutableOnPath,
  formatCursorBinaryMissingMessage,
  resolveCursorRuntimeBinary,
} from "./providers/cursor/binary.js";
export { probeCursorCapability } from "./providers/cursor/capability.js";
export {
  type CursorAuthDriverDeps,
  type CursorBrowserLoginOptions,
  createCursorAuthDriver,
  runCursorBrowserLogin,
} from "./providers/cursor/login.js";
export {
  type DiscoverModelsDeps,
  discoverProviderModels,
  parseCursorModelsOutput,
  parseKimiConfigModels,
} from "./providers/discover-models.js";
export {
  findGrokExecutableOnPath,
  formatGrokBinaryMissingMessage,
  GROK_INSTALL_COMMAND,
  type GrokRuntimeBinaryResolution,
  resolveGrokRuntimeBinary,
} from "./providers/grok/binary.js";
export { probeGrokCapability } from "./providers/grok/capability.js";
export {
  createGrokAuthDriver,
  type GrokAuthDriverDeps,
  type GrokBrowserLoginOptions,
  runGrokBrowserLogin,
} from "./providers/grok/login.js";
export { createKimiCodeHandler, formatKimiCodeError, kimiToolIsReadOnly } from "./providers/kimi-code/index.js";
export {
  findOpenCodeExecutableOnPath,
  formatOpenCodeBinaryMissingMessage,
  isSupportedOpenCodeVersion,
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_LOGIN_COMMAND,
  OPENCODE_MINIMUM_VERSION,
  OPENCODE_SUPPORTED_VERSION_RANGE,
  parseOpenCodeVersionOutput,
  resolveOpenCodeRuntimeBinary,
} from "./providers/opencode/binary.js";
export { probeOpenCodeCapability } from "./providers/opencode/capability.js";
export {
  buildOpenCodeConfigContent,
  buildOpenCodeTurnArgs,
  createOpenCodeHandler,
  mapOpenCodeMcpServers,
} from "./providers/opencode/index.js";
export {
  findPiExecutableOnPath,
  formatPiBinaryMissingMessage,
  isSupportedPiVersion,
  PI_INSTALL_COMMAND,
  PI_LOGIN_COMMAND,
  PI_MINIMUM_VERSION,
  PI_SUPPORTED_VERSION_RANGE,
  parsePiVersionOutput,
  resolvePiRuntimeBinary,
} from "./providers/pi/binary.js";
export { probePiCapability } from "./providers/pi/capability.js";
// Runtime-auth (browser OAuth)
export {
  AUTH_URL_TOKEN_MAX,
  type AuthUrlScanner,
  BROWSER_LOGIN_TIMEOUT_MS,
  createAuthUrlScanner,
  extractAuthUrl,
  LOGIN_STDERR_TAIL_MAX,
  type LoginOutcome,
  stripAnsi,
} from "./providers/runtime-login.js";
export { PROVIDER_SKILL_ROOTS } from "./providers/skill-roots.js";
