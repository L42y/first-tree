import type { Agent } from "@first-tree/shared";
import { canManageAgentDetail } from "./access.js";

export type TabDef = { key: string; label: string; path: string };

// IA labels only. Routing `path` and the `key` (deep-link mapping) are kept
// stable so existing URLs keep resolving. Responsibilities has its own stable
// deep link alongside the previously added Runtime and Repositories routes.
const TAB_LABELS: Record<string, string> = {
  profile: "Profile",
  responsibilities: "Responsibilities",
  runtime: "Runtime",
  prompt: "Instructions",
  capabilities: "Tools & skills",
  repositories: "Repositories",
  usage: "Usage",
};

/**
 * Inputs for whether the Responsibilities tab should appear. Hide only when
 * both the public official Template catalog and the agent's adopted
 * `templateIds` are confirmed empty. Loading and request failures must fail
 * open (keep the tab) so uncertainty is never treated as "no data".
 */
export type ResponsibilitiesVisibilityInput = {
  catalogFetched: boolean;
  catalogError: boolean;
  catalogCount: number;
  agentResourcesFetched: boolean;
  agentResourcesError: boolean;
  agentTemplateIdCount: number;
};

/**
 * Whether Agent Detail should expose the Responsibilities tab.
 *
 * - Humans never see it.
 * - Non-humans see it whenever the public catalog has any templates, or the
 *   agent already carries adopted Template ids (active / retired / missing
 *   provenance still needs a home).
 * - Hide only when both sides are confirmed empty.
 * - When the agent's resources are still unknown, `assumeShowWhenAgentUnknown`
 *   controls fail-open (page chrome) vs fail-closed (switcher path preservation
 *   must not send the user into an entry that will immediately close).
 */
export function shouldShowResponsibilitiesTab(
  isHuman: boolean,
  input: ResponsibilitiesVisibilityInput | null,
  opts?: { assumeShowWhenAgentUnknown?: boolean },
): boolean {
  if (isHuman) return false;
  if (!input) return true;
  if (!input.catalogFetched || input.catalogError) return true;
  if (input.catalogCount > 0) return true;
  // Catalog is confirmed empty — keep the tab only when this agent still has
  // adopted Template responsibilities (including retired / missing provenance).
  if (!input.agentResourcesFetched || input.agentResourcesError) {
    return opts?.assumeShowWhenAgentUnknown ?? true;
  }
  return input.agentTemplateIdCount > 0;
}

/**
 * Single source of truth for WHICH tabs exist for an agent (key + path),
 * independent of label/order. `buildTabs` adds the display label on top, and the
 * agent switcher uses this to know whether a target agent supports the current
 * tab — so the two can never drift on tab availability.
 */
export function tabKeysFor(
  canEditConfig: boolean,
  isHuman: boolean,
  showResponsibilities: boolean = !isHuman,
): { key: string; path: string }[] {
  const tabs: { key: string; path: string }[] = [{ key: "profile", path: "profile" }];
  if (showResponsibilities) {
    tabs.push({ key: "responsibilities", path: "responsibilities" });
  }
  if (canEditConfig) {
    // Responsibility comes directly after identity, followed by Runtime
    // (model/effort/computer/env), Instructions, then the two resource tabs.
    // Repositories is editor-only — repos + the read-only context tree lived on
    // the old (editor-only) Environment tab, so non-editors never saw them and
    // still don't.
    tabs.push(
      { key: "runtime", path: "runtime" },
      { key: "prompt", path: "prompt" },
      { key: "capabilities", path: "capabilities" },
      { key: "repositories", path: "repositories" },
    );
  } else if (!isHuman) {
    tabs.push({ key: "capabilities", path: "capabilities" });
  }
  // Usage is an observation surface, kept last; human-type agents have no token usage.
  if (!isHuman) {
    tabs.push({ key: "usage", path: "usage" });
  }
  return tabs;
}

export function buildTabs(
  canEditConfig: boolean,
  isHuman: boolean,
  showResponsibilities: boolean = !isHuman,
): TabDef[] {
  return tabKeysFor(canEditConfig, isHuman, showResponsibilities).map((t) => ({
    ...t,
    label: TAB_LABELS[t.key] ?? t.key,
  }));
}

/** Mirror of the shell's `canEditConfig` derivation, for any agent (e.g. switcher targets). */
export function canEditConfigFor(agent: Agent, memberId: string | null, role: string | null): boolean {
  return agent.type !== "human" && canManageAgentDetail(agent, memberId, role);
}

/**
 * Which tab PATH to open when switching to `agent`: keep the current tab when the
 * target supports it, else fall back to profile. (Some tabs render blank rather
 * than redirect for unsupported agents, so we resolve this up front.)
 */
export function resolveTabPath(
  agent: Agent,
  memberId: string | null,
  role: string | null,
  currentPath: string,
  showResponsibilities: boolean = agent.type !== "human",
): string {
  const paths = tabKeysFor(canEditConfigFor(agent, memberId, role), agent.type === "human", showResponsibilities).map(
    (t) => t.path,
  );
  return paths.includes(currentPath) ? currentPath : "profile";
}
