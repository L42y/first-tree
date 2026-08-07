/**
 * Provider-support host-runtime group.
 *
 * Cross-cutting Runtime-owned host helpers that adapters need outside full
 * managed-session admission: briefing rewrite for hot-switch, workspace marker
 * constants, CLI binding, and git path resolution under the agent home.
 * Concrete provider binary / login / capability modules are not re-exported.
 */

export type { AgentConfigCache } from "../agent-config-cache.js";
export type { PredeclaredSourceRepo } from "../bootstrap.js";
export { FIRST_TREE_WORKSPACE_MARKER, writeAgentBriefing } from "../bootstrap.js";

export { getCliBinding } from "../cli-binding.js";

export { resolveGitRepoTargetPath } from "../git-local-path.js";
