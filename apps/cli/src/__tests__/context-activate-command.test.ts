import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const mocks = vi.hoisted(() => ({
  hook: vi.fn(),
  inspectRuntime: vi.fn(),
}));

vi.mock("../core/output.js", () => ({
  print: {
    hook: mocks.hook,
  },
}));

vi.mock("../core/context-integration/runtime-health.js", () => ({
  inspectContextIntegrationRuntime: mocks.inspectRuntime,
}));

import { runContextActivate } from "../commands/context/activate.js";

function context(options: Record<string, unknown>): CommandContext {
  return {
    command: {
      opts: () => options,
    } as unknown as Command,
    options: { json: false, debug: false, quiet: false },
  };
}

describe("context activate command", () => {
  it("keeps stale Plugin sessions usable and makes repair explicit-user-only", async () => {
    mocks.inspectRuntime.mockReturnValue({
      healthy: false,
      issues: ["The installed Context Plugin payload differs from this release."],
      install: { adapterDigest: "sha256:old" },
      release: { manifest: { providers: { codex: { adapterDigest: "sha256:new" } } } },
    });

    await runContextActivate(context({ provider: "codex", releaseDigest: "sha256:old" }));

    expect(mocks.hook).toHaveBeenCalledOnce();
    const response = mocks.hook.mock.calls[0]?.[0];
    expect(response).toMatchObject({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
      },
    });
    expect(response.systemMessage).toContain("Ordinary provider work can continue.");
    expect(response.systemMessage).toContain("first-tree-dev context repair --provider codex");
    expect(response.hookSpecificOutput.additionalContext).toContain(
      "Do not repair, upgrade, or synchronize the Plugin automatically.",
    );
    expect(response.hookSpecificOutput.additionalContext).toContain("Only if the user explicitly asks");
  });
});
