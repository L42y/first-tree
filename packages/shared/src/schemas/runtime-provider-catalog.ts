import {
  asRuntimeProvider,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProvider,
} from "./runtime-provider.js";

/**
 * Cross-package pure-data catalog for runtime providers.
 *
 * Owns labels, display order, and install/login metadata shared by web/CLI
 * surfaces (Computers cards, new-agent dialog, agent detail, chat auth hints).
 * Must not contain executable client code (handler factories, probes, binary
 * resolvers, or third-party SDK imports).
 */
export type RuntimeProviderCatalogEntry = {
  id: RuntimeProvider;
  label: string;
  /** Ascending display order for selection/setup UIs and preferred-runtime pick. */
  displayOrder: number;
  /** npm package for `npm install -g`, or `null` when install is script-only. */
  npmPackage: string | null;
  /** Extra args inserted after `npm install -g` (e.g. `--ignore-scripts`). */
  npmInstallArgs: readonly string[];
  /** Official installer script when `npmPackage` is null. */
  scriptInstallCommand: string | null;
  /** Default host-local login / recovery command shown after install. */
  loginCommand: string;
  /**
   * Markdown fragment embedded in chat auth-failure hints (includes backticks).
   * May differ slightly from {@link loginCommand} for interactive `/login` flows.
   */
  chatAuthLoginPhrase: string;
  /** Vendor / credential owner named in chat auth-failure hints. */
  authOwnerLabel: string;
};

const CURSOR_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";
const GROK_INSTALL_COMMAND = "curl -fsSL https://x.ai/cli/install.sh | bash";

/**
 * Exhaustive catalog keyed by every {@link RuntimeProvider}. Adding a provider
 * requires a new entry here (TypeScript `satisfies` enforces completeness).
 */
export const RUNTIME_PROVIDER_CATALOG = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    displayOrder: 10,
    npmPackage: "@anthropic-ai/claude-code",
    npmInstallArgs: [],
    scriptInstallCommand: null,
    loginCommand: "claude auth login",
    chatAuthLoginPhrase: "`claude auth login`",
    authOwnerLabel: "Anthropic",
  },
  "claude-code-tui": {
    id: "claude-code-tui",
    label: "Claude Code CLI",
    displayOrder: 20,
    npmPackage: "@anthropic-ai/claude-code",
    npmInstallArgs: [],
    scriptInstallCommand: null,
    loginCommand: "claude auth login",
    chatAuthLoginPhrase: "`claude auth login`",
    authOwnerLabel: "Anthropic",
  },
  codex: {
    id: "codex",
    label: "Codex",
    displayOrder: 30,
    npmPackage: "@openai/codex",
    npmInstallArgs: [],
    scriptInstallCommand: null,
    loginCommand: "codex login",
    chatAuthLoginPhrase: "`codex login`",
    authOwnerLabel: "OpenAI",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    displayOrder: 40,
    npmPackage: null,
    npmInstallArgs: [],
    scriptInstallCommand: CURSOR_INSTALL_COMMAND,
    loginCommand: "cursor-agent login",
    chatAuthLoginPhrase: "`cursor-agent login`",
    authOwnerLabel: "Cursor",
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    displayOrder: 50,
    npmPackage: null,
    npmInstallArgs: [],
    scriptInstallCommand: GROK_INSTALL_COMMAND,
    loginCommand: "grok login",
    chatAuthLoginPhrase: "`grok login`",
    authOwnerLabel: "Grok Build",
  },
  "kimi-code": {
    id: "kimi-code",
    label: "Kimi Code",
    displayOrder: 60,
    npmPackage: "@moonshot-ai/kimi-code",
    npmInstallArgs: [],
    scriptInstallCommand: null,
    loginCommand: "kimi # then run /login",
    chatAuthLoginPhrase: "`kimi` and then `/login`",
    authOwnerLabel: "Kimi",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    displayOrder: 70,
    npmPackage: "opencode-ai@^1.18.7",
    npmInstallArgs: [],
    scriptInstallCommand: null,
    loginCommand: "opencode auth login",
    chatAuthLoginPhrase: "`opencode auth login`",
    authOwnerLabel: "OpenCode's selected provider",
  },
  pi: {
    id: "pi",
    label: "Pi",
    displayOrder: 80,
    npmPackage: "@earendil-works/pi-coding-agent",
    npmInstallArgs: ["--ignore-scripts"],
    scriptInstallCommand: null,
    loginCommand: "pi # then run /login",
    chatAuthLoginPhrase: "`pi` and then `/login`",
    authOwnerLabel: "Pi",
  },
} as const satisfies Record<RuntimeProvider, RuntimeProviderCatalogEntry>;

/** All known providers sorted by catalog display order (includes disabled). */
export const RUNTIME_PROVIDER_DISPLAY_ORDER: readonly RuntimeProvider[] = [...RUNTIME_PROVIDER_IDS].sort(
  (a, b) => RUNTIME_PROVIDER_CATALOG[a].displayOrder - RUNTIME_PROVIDER_CATALOG[b].displayOrder,
);

/** Enabled providers only, in display order — drives selection / setup UIs. */
export function enabledRuntimeProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDER_DISPLAY_ORDER.filter((p) => isRuntimeProviderEnabled(p));
}

/** Label map derived from the catalog (kept for call sites expecting a Record). */
export const RUNTIME_PROVIDER_LABELS: Readonly<Record<RuntimeProvider, string>> = Object.fromEntries(
  RUNTIME_PROVIDER_IDS.map((id) => [id, RUNTIME_PROVIDER_CATALOG[id].label]),
) as Record<RuntimeProvider, string>;

/** Friendly runtime label, falling back to the raw id when unknown. */
export function runtimeProviderLabel(provider: string): string {
  const known = asRuntimeProvider(provider);
  return known ? RUNTIME_PROVIDER_CATALOG[known].label : provider;
}

/**
 * Single install command line for a provider: `npm install -g …` when an npm
 * package exists, otherwise the official installer script.
 */
export function runtimeProviderInstallCommand(provider: RuntimeProvider): string {
  const entry = RUNTIME_PROVIDER_CATALOG[provider];
  if (entry.npmPackage) {
    const args = entry.npmInstallArgs.length > 0 ? `${entry.npmInstallArgs.join(" ")} ` : "";
    return `npm install -g ${args}${entry.npmPackage}`;
  }
  return entry.scriptInstallCommand ?? "";
}

/** Default login / recovery command from the catalog. */
export function runtimeProviderLoginCommand(provider: RuntimeProvider): string {
  return RUNTIME_PROVIDER_CATALOG[provider].loginCommand;
}

/** Chat-timeline auth recovery phrase (includes markdown backticks). */
export function runtimeProviderChatAuthLoginPhrase(provider: RuntimeProvider): string {
  return RUNTIME_PROVIDER_CATALOG[provider].chatAuthLoginPhrase;
}

/** Credential-owner label used in chat auth-failure hints. */
export function runtimeProviderAuthOwnerLabel(provider: RuntimeProvider): string {
  return RUNTIME_PROVIDER_CATALOG[provider].authOwnerLabel;
}

/**
 * Install + login two-liner for setup surfaces. Optional `extraLines` lets a
 * presentation layer append host-specific requirements (e.g. tmux).
 */
export function runtimeProviderInstallLoginCommand(
  provider: RuntimeProvider,
  extraLines: readonly string[] = [],
): string {
  const lines = [runtimeProviderInstallCommand(provider), runtimeProviderLoginCommand(provider), ...extraLines];
  return lines.join("\n");
}

/**
 * First enabled provider whose capability entry is `ok`, following catalog
 * display order (Claude Code → …). Returns null when none are ready.
 */
export function pickPreferredRuntimeProvider(
  caps: Readonly<Partial<Record<string, { state?: string } | null | undefined>>>,
): RuntimeProvider | null {
  for (const provider of RUNTIME_PROVIDER_DISPLAY_ORDER) {
    if (!isRuntimeProviderEnabled(provider)) continue;
    if (caps[provider]?.state === "ok") return provider;
  }
  return null;
}

export { CURSOR_INSTALL_COMMAND, GROK_INSTALL_COMMAND };
