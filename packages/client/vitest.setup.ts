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

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { setCliBinding } from "./src/runtime/cli-binding.js";

// macOS exposes the temporary root through the `/var` compatibility symlink.
// Workspace trust tests must start from the canonical `/private/var` path so
// ordinary fixtures do not accidentally exercise the intentional
// symlink-ancestor rejection path.
process.env.TMPDIR = realpathSync(tmpdir());

vi.mock("./src/runtime/managed-skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/runtime/managed-skills.js")>();
  return {
    ...actual,
    reconcileManagedSkillsForConfig: vi.fn(
      async (
        workspace: string,
        provider: import("@first-tree/shared").RuntimeProvider,
        providerSkillRoots: import("./src/runtime/managed-skills.js").ProviderSkillRootProjection,
        config: import("@first-tree/shared").AgentRuntimeConfig | null | undefined,
        _log?: (message: string) => void,
        _bundleResolver?: unknown,
        contextSourceKind: "remote" | "local" | "none" = "remote",
      ) => {
        const root = join(workspace, actual.providerSkillRoot(provider, providerSkillRoots));
        for (const name of ["first-tree-read", "first-tree-write"]) {
          const skillDir = join(root, name);
          mkdirSync(skillDir, { recursive: true });
          writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`);
          writeFileSync(
            join(skillDir, ".first-tree-managed.json"),
            JSON.stringify({ revision: contextSourceKind === "local" ? "local-context:test" : "test-public:1" }),
          );
        }
        return {
          ok: true,
          resourceConfigVersion: config?.version ?? 0,
          installed: [],
          skipped: [],
          removed: [],
          teamSkills: [],
          failures: [],
          staleTeamSnapshot: false,
        };
      },
    ),
    verifyManagedSkillsProjectionForAdmission: vi.fn(async () => ({ resourceConfigVersion: 0, teamSkills: [] })),
  };
});

setCliBinding({ binName: "first-tree", packageName: "first-tree" });
