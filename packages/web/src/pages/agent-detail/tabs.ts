export type TabDef = { key: string; label: string; path: string; description: string };

// IA labels only. Routing `path` and the `key` (deep-link mapping) are kept
// stable for the remaining sections. The retired Responsibilities deep link is
// handled as a redirect in app.tsx and is no longer part of this collection.
const TAB_LABELS: Record<string, string> = {
  profile: "Profile",
  runtime: "Runtime",
  prompt: "Instructions",
  capabilities: "Tools & skills",
  repositories: "Repositories",
  usage: "Usage",
};

const TAB_DESCRIPTIONS: Record<string, string> = {
  profile: "Identity, ownership, and lifecycle for this agent.",
  runtime: "Where this agent runs and how it is configured.",
  prompt: "Guidance that shapes how this agent behaves.",
  capabilities: "Skills and integrations configured for this agent.",
  repositories: "Code repositories and team context available in this agent’s workspace.",
  usage: "Activity and turn history for this agent.",
};

/**
 * Single source of truth for WHICH sections exist for an agent (key + path),
 * independent of label/order. `buildTabs` adds the display label and description.
 */
export function tabKeysFor(canEditConfig: boolean, isHuman: boolean): { key: string; path: string }[] {
  const tabs: { key: string; path: string }[] = [{ key: "profile", path: "profile" }];
  if (canEditConfig) {
    // Runtime (model/effort/computer/env) comes first, followed by Instructions
    // and the two resource tabs. Adopted Template provenance lives inside Profile.
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

export function buildTabs(canEditConfig: boolean, isHuman: boolean): TabDef[] {
  return tabKeysFor(canEditConfig, isHuman).map((t) => ({
    ...t,
    label: TAB_LABELS[t.key] ?? t.key,
    description: TAB_DESCRIPTIONS[t.key] ?? "",
  }));
}
