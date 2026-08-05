import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const output = vi.hoisted(() => ({ hook: vi.fn() }));

vi.mock("../core/output.js", () => ({ print: output }));

import { runContextObserveLoaded } from "../commands/context/observe-loaded.js";

describe("context observe-loaded command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is a pure no-op when the loaded adapter has no reload obligation", () => {
    const inspectObligation = vi.fn(() => null);
    const issueReceipt = vi.fn();

    runContextObserveLoaded(context(), { inspectObligation, issueReceipt });

    expect(inspectObligation).toHaveBeenCalledOnce();
    expect(issueReceipt).not.toHaveBeenCalled();
    expect(output.hook).toHaveBeenCalledWith({ continue: true });
  });
});

function context(): CommandContext {
  return {
    command: {
      opts: () => ({
        provider: "claude-code",
        adapterDigest: `sha256:${"a".repeat(64)}`,
        adoptionGeneration: "b".repeat(48),
      }),
    } as unknown as Command,
    options: { json: false, debug: false, quiet: false },
  };
}
