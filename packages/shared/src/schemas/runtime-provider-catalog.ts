import {
  asRuntimeProvider,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProvider,
  recordByRuntimeProvider,
} from "./runtime-provider.js";

/** Official installer scripts (also re-exported for client binary remediation). */
export const CURSOR_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";
export const GROK_INSTALL_COMMAND = "curl -fsSL https://x.ai/cli/install.sh | bash";

/**
 * OpenCode CLI minimum supported version. Catalog npm package and client
 * capability gates share this constant — do not parse it back out of the
 * package string.
 */
export const OPENCODE_MINIMUM_VERSION = "1.18.7";
export const OPENCODE_NPM_PACKAGE = `opencode-ai@^${OPENCODE_MINIMUM_VERSION}`;

export const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";

/** Provider-owned install metadata — npm package or official installer script. */
export type RuntimeProviderInstall =
  | { kind: "npm"; package: string; args: readonly string[] }
  | { kind: "script"; command: string };

/**
 * Ordered login steps for setup / auth-recovery surfaces.
 * Shell providers have exactly one step; interactive providers (Kimi / Pi)
 * have exactly two (`program`, slash-command).
 */
export type RuntimeProviderLoginSteps = readonly [string] | readonly [string, string];

/**
 * Cross-package pure-data catalog for runtime providers.
 *
 * Owns labels, display/selection order, install/login metadata, and auth-owner
 * copy shared by web/CLI/client notice surfaces. Must not contain executable
 * client code (handler factories, probes, binary resolvers, or SDKs).
 */
export type RuntimeProviderCatalogEntry = {
  id: RuntimeProvider;
  label: string;
  /** Ascending order for setup-card / matrix display. */
  displayOrder: number;
  /**
   * Ascending order for preferred-runtime auto-pick (may differ from display).
   * Locked to phase-1 new-agent priority: Claude → TUI → Codex → Cursor → Grok
   * → OpenCode → Pi → Kimi.
   */
  selectionPriority: number;
  install: RuntimeProviderInstall;
  loginSteps: RuntimeProviderLoginSteps;
  /** Credential owner named in chat auth-failure hints. */
  authOwnerLabel: string;
};

/**
 * Exhaustive catalog keyed by every {@link RuntimeProvider}.
 */
export const RUNTIME_PROVIDER_CATALOG = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    displayOrder: 10,
    selectionPriority: 10,
    install: { kind: "npm", package: "@anthropic-ai/claude-code", args: [] },
    loginSteps: ["claude auth login"],
    authOwnerLabel: "Anthropic",
  },
  "claude-code-tui": {
    id: "claude-code-tui",
    label: "Claude Code CLI",
    displayOrder: 20,
    selectionPriority: 20,
    install: { kind: "npm", package: "@anthropic-ai/claude-code", args: [] },
    loginSteps: ["claude auth login"],
    authOwnerLabel: "Anthropic",
  },
  codex: {
    id: "codex",
    label: "Codex",
    displayOrder: 30,
    selectionPriority: 30,
    install: { kind: "npm", package: "@openai/codex", args: [] },
    loginSteps: ["codex login"],
    authOwnerLabel: "OpenAI",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    displayOrder: 40,
    selectionPriority: 40,
    install: { kind: "script", command: CURSOR_INSTALL_COMMAND },
    loginSteps: ["cursor-agent login"],
    authOwnerLabel: "Cursor",
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    displayOrder: 50,
    selectionPriority: 50,
    install: { kind: "script", command: GROK_INSTALL_COMMAND },
    loginSteps: ["grok login"],
    authOwnerLabel: "Grok Build",
  },
  "kimi-code": {
    id: "kimi-code",
    label: "Kimi Code",
    // Display sits with other npm CLIs after Grok; selection stays last among
    // known providers (phase-1 new-agent priority).
    displayOrder: 60,
    selectionPriority: 80,
    install: { kind: "npm", package: "@moonshot-ai/kimi-code", args: [] },
    loginSteps: ["kimi", "/login"],
    authOwnerLabel: "Kimi",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    displayOrder: 70,
    selectionPriority: 60,
    install: { kind: "npm", package: OPENCODE_NPM_PACKAGE, args: [] },
    loginSteps: ["opencode auth login"],
    authOwnerLabel: "OpenCode's selected provider",
  },
  pi: {
    id: "pi",
    label: "Pi",
    displayOrder: 80,
    selectionPriority: 70,
    install: { kind: "npm", package: PI_NPM_PACKAGE, args: ["--ignore-scripts"] },
    loginSteps: ["pi", "/login"],
    authOwnerLabel: "Pi",
  },
} as const satisfies Record<RuntimeProvider, RuntimeProviderCatalogEntry>;

/** All known providers sorted by catalog display order (includes disabled). */
export const RUNTIME_PROVIDER_DISPLAY_ORDER: readonly RuntimeProvider[] = [...RUNTIME_PROVIDER_IDS].sort(
  (a, b) => RUNTIME_PROVIDER_CATALOG[a].displayOrder - RUNTIME_PROVIDER_CATALOG[b].displayOrder,
);

/** All known providers sorted by selection priority (includes disabled). */
export const RUNTIME_PROVIDER_SELECTION_ORDER: readonly RuntimeProvider[] = [...RUNTIME_PROVIDER_IDS].sort(
  (a, b) => RUNTIME_PROVIDER_CATALOG[a].selectionPriority - RUNTIME_PROVIDER_CATALOG[b].selectionPriority,
);

/** Enabled providers only, in display order — drives setup / matrix UIs. */
export function enabledRuntimeProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDER_DISPLAY_ORDER.filter((p) => isRuntimeProviderEnabled(p));
}

/** Label map derived from the catalog. */
export const RUNTIME_PROVIDER_LABELS: Readonly<Record<RuntimeProvider, string>> = recordByRuntimeProvider(
  RUNTIME_PROVIDER_IDS.map((id) => [id, RUNTIME_PROVIDER_CATALOG[id].label] as const),
);

/** Friendly runtime label, falling back to the raw id when unknown. */
export function runtimeProviderLabel(provider: string): string {
  const known = asRuntimeProvider(provider);
  return known ? RUNTIME_PROVIDER_CATALOG[known].label : provider;
}

/** Structured login steps from the catalog. */
export function runtimeProviderLoginSteps(provider: RuntimeProvider): RuntimeProviderLoginSteps {
  return RUNTIME_PROVIDER_CATALOG[provider].loginSteps;
}

/**
 * Single install command line for a provider: `npm install -g …` or the
 * official installer script.
 */
export function runtimeProviderInstallCommand(provider: RuntimeProvider): string {
  const install = RUNTIME_PROVIDER_CATALOG[provider].install;
  if (install.kind === "npm") {
    const args = install.args.length > 0 ? `${install.args.join(" ")} ` : "";
    return `npm install -g ${args}${install.package}`;
  }
  return install.command;
}

/**
 * Shell / comment-form login line for setup cards.
 * One-step → command; two-step → `program # then run /login`.
 */
export function runtimeProviderLoginCommand(provider: RuntimeProvider): string {
  const steps = runtimeProviderLoginSteps(provider);
  if (steps.length === 1) return steps[0];
  const [program, slashCommand] = steps;
  return `${program} # then run ${slashCommand}`;
}

/**
 * Chat-timeline auth recovery phrase (includes markdown backticks).
 * Derived from {@link runtimeProviderLoginSteps} — no parallel phrase strings.
 */
export function runtimeProviderChatAuthLoginPhrase(provider: RuntimeProvider): string {
  const steps = runtimeProviderLoginSteps(provider);
  if (steps.length === 1) return `\`${steps[0]}\``;
  const [program, slashCommand] = steps;
  return `\`${program}\` and then \`${slashCommand}\``;
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
 * selection priority (not display order). Returns null when none are ready.
 */
export function pickPreferredRuntimeProvider(
  caps: Readonly<Partial<Record<string, { state?: string } | null | undefined>>>,
): RuntimeProvider | null {
  for (const provider of RUNTIME_PROVIDER_SELECTION_ORDER) {
    if (!isRuntimeProviderEnabled(provider)) continue;
    if (caps[provider]?.state === "ok") return provider;
  }
  return null;
}

/**
 * Enabled providers in catalog **display** order whose capability state is `ok`.
 *
 * Use this for selectable option lists — never `Object.entries(caps)`, which
 * follows probe-completion insertion order and is nondeterministic.
 */
export function enabledOkRuntimeProviders(
  caps: Readonly<Partial<Record<string, { state?: string } | null | undefined>>>,
): RuntimeProvider[] {
  return enabledRuntimeProviders().filter((provider) => caps[provider]?.state === "ok");
}
