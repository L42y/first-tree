import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const memberMocks = vi.hoisted(() => ({ createMemberSdk: vi.fn() }));
const coreMocks = vi.hoisted(() => ({ preflightContextTreeSeed: vi.fn() }));
const outputMocks = vi.hoisted(() => ({
  fail: vi.fn(),
  isJsonMode: vi.fn(() => true),
  result: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../commands/_shared/member.js", () => memberMocks);
vi.mock("../core/context-tree-seed.js", () => ({
  ContextTreeSeedPreflightCliError: class extends Error {},
  preflightContextTreeSeed: coreMocks.preflightContextTreeSeed,
}));
vi.mock("../core/output.js", () => ({
  isJsonMode: outputMocks.isJsonMode,
  print: outputMocks,
}));

describe("tree seed source confirmation bridge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs one Admin preflight before the exact optimistic source batch", async () => {
    const sdk = {
      preflightMemberContextTreeSeed: vi.fn(),
      confirmMemberTeamRepositories: vi.fn().mockResolvedValue({
        repositories: [{ id: "repo-1", repoCanonicalKey: "github.com/acme/app" }],
      }),
    };
    memberMocks.createMemberSdk.mockReturnValue(sdk);
    coreMocks.preflightContextTreeSeed.mockImplementation(async (reader, input) => {
      await reader.preflightMemberContextTreeSeed(input.teamId, {}, { retry: false });
      return { teamId: input.teamId, state: { status: "unbound", branch: "main" } };
    });
    const { runTreeSeedCommand } = await import("../commands/tree/seed.js");

    await runTreeSeedCommand({
      command: {
        opts: () => ({
          team: "team-a",
          confirmSource: ["https://github.com/acme/app.git"],
          expectedSourceKey: ["github.com/acme/existing"],
        }),
      } as unknown as Command,
      options: { debug: false, json: true, quiet: false },
    });

    expect(sdk.confirmMemberTeamRepositories).toHaveBeenCalledWith("team-a", {
      expectedActiveRepositoryKeys: ["github.com/acme/existing"],
      repositories: [{ name: "acme/app", url: "https://github.com/acme/app.git" }],
    });
    expect(outputMocks.result).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-a",
        sourceRepositories: [{ id: "repo-1", repoCanonicalKey: "github.com/acme/app" }],
      }),
    );
  });
});
