// Vitest global setup. Installs a default CLI binding so every test file
// that reaches `bootstrap.ts` (directly via `bootstrapWorkspace` or
// indirectly through a handler's `start()`) sees a populated binding. The
// CLI entrypoint (`apps/cli/src/core/channel-env.ts`) installs this in
// production from `channelConfig`; tests don't go through that entry, so we
// pin a prod-shaped default here.
//
// Individual tests can override with `setCliBinding({...})` and reset in
// their own `afterEach` — see `__tests__/bootstrap.test.ts` for the
// staging/dev channel cases.
//
// Handler unit suites exercise provider transport timing with fake clocks and
// tiny wait budgets. Keep managed filesystem reconciliation at that boundary
// as a default test double; `managed-skills.test.ts` exercises the real
// reconciler directly, and integration suites can `vi.unmock` it explicitly.
// This prevents eight fsync-backed Core Skill transactions from becoming an
// unrelated timing dependency in every provider transport test.

import { vi } from "vitest";
import { setCliBinding } from "./src/runtime/cli-binding.js";

vi.mock("./src/runtime/managed-skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/runtime/managed-skills.js")>();
  return {
    ...actual,
    reconcileManagedSkillsForConfig: vi.fn(
      async (
        _workspace: string,
        _provider: import("@first-tree/shared").RuntimeProvider,
        _providerSkillRoots: Readonly<Record<import("@first-tree/shared").RuntimeProvider, string>>,
        config: import("@first-tree/shared").AgentRuntimeConfig | null | undefined,
      ) => ({
        ok: true,
        resourceConfigVersion: config?.version ?? 0,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [],
        failures: [],
        staleTeamSnapshot: false,
      }),
    ),
  };
});

setCliBinding({ binName: "first-tree", packageName: "first-tree" });
