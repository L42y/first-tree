// Vitest global setup for client-providers.
// Installs a default CLI binding and stubs managed-skills reconcile so provider
// transport unit suites do not pay real fsync-backed skill projection cost.

import { setCliBinding } from "@first-tree/client-runtime/runtime/cli-binding.js";
import { vi } from "vitest";

vi.mock("@first-tree/client-runtime/runtime/managed-skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@first-tree/client-runtime/runtime/managed-skills.js")>();
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
