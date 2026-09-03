/**
 * How an agent is actually configured — the runtime, its model, and how hard
 * it thinks. Rosters carry the runtime provider; the model and effort live in
 * the per-agent runtime config, which only the agent's manager may read, so a
 * row degrades to the provider alone rather than lying about the rest.
 */
export type AgentRuntimeSummary = {
  provider: string | null;
  model: string | null;
  /** "" in the config means "inherit the runtime's default", i.e. nothing to show. */
  effort: string | null;
  /** Lifecycle status from the roster row ("active" / "suspended"). */
  status?: string | null;
  /** Live runtime state from presence: idle / working / blocked / error. */
  runtimeState?: string | null;
  presenceStatus?: string | null;
  /** True when this member manages the agent, i.e. may pause or resume it. */
  managed?: boolean;
};

const PROVIDER_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-code-tui": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  amp: "Amp",
  grok: "Grok",
  "kimi-code": "Kimi",
  opencode: "OpenCode",
  "deepseek-harness": "DeepSeek",
  pi: "Pi",
};

/** Human-readable runtime name; unknown providers show their raw id. */
export function providerLabel(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * What to print for the model. A configured model wins; an empty one means the
 * agent runs its runtime's default, which is best described by the runtime's
 * own name rather than a blank or a fabricated model id.
 */
export function modelLabel(summary: AgentRuntimeSummary): string | null {
  const model = summary.model?.trim();
  if (model) return model;
  return providerLabel(summary.provider);
}

/** Effort is only worth a chip when it was actually chosen. */
export function effortLabel(summary: AgentRuntimeSummary): string | null {
  const effort = summary.effort?.trim();
  return effort ? effort : null;
}

/** Reads the model / effort out of whichever provider variant the payload is. */
export function summarizeRuntimeConfig(payload: unknown, provider: string | null): AgentRuntimeSummary {
  const config = (payload ?? {}) as { model?: unknown; reasoningEffort?: unknown; kind?: unknown };
  return {
    provider: provider ?? (typeof config.kind === "string" ? config.kind : null),
    model: typeof config.model === "string" ? config.model : null,
    effort: typeof config.reasoningEffort === "string" ? config.reasoningEffort : null,
  };
}

export type AgentActivityKey = "paused" | "working" | "blocked" | "error" | "idle" | "offline";

export type AgentActivity = {
  key: AgentActivityKey;
  label: string;
  /** Ionicons glyph name. */
  icon: string;
  /** One of the theme's semantic roles, resolved by the renderer. */
  tone: "positive" | "warning" | "danger" | "muted";
};

/**
 * What the agent is doing right now, in the order that matters to a reader: a
 * paused agent is not going to answer no matter what presence says, a live
 * runtime state beats mere connectivity, and an agent with no presence row at
 * all is simply not connected.
 */
export function agentActivity(summary: AgentRuntimeSummary | undefined): AgentActivity | null {
  if (!summary) return null;
  if (summary.status === "suspended") {
    return { key: "paused", label: "Paused", icon: "pause-circle-outline", tone: "warning" };
  }
  switch (summary.runtimeState) {
    case "working":
      return { key: "working", label: "Working", icon: "flash", tone: "positive" };
    case "blocked":
      return { key: "blocked", label: "Blocked", icon: "hand-left-outline", tone: "warning" };
    case "error":
      return { key: "error", label: "Error", icon: "alert-circle-outline", tone: "danger" };
    case "idle":
      return { key: "idle", label: "Idle", icon: "ellipse-outline", tone: "muted" };
    default:
      break;
  }
  if (summary.presenceStatus === "online") {
    return { key: "idle", label: "Idle", icon: "ellipse-outline", tone: "muted" };
  }
  return { key: "offline", label: "Offline", icon: "cloud-offline-outline", tone: "muted" };
}

/** Only a manager may pause or resume, and only an agent can be paused at all. */
export function canToggleAgentRun(summary: AgentRuntimeSummary | undefined): boolean {
  return Boolean(summary?.managed);
}
