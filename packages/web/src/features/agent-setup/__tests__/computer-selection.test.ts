import { describe, expect, it } from "vitest";
import { resolveComputerSelection, resolveRuntimeSelection } from "../computer-selection.js";

describe("resolveComputerSelection", () => {
  it("uses the only connected computer without asking", () => {
    expect(
      resolveComputerSelection({
        clientIds: ["client-1"],
        currentClientId: null,
        explicitlySelectedClientId: null,
        requireExplicitWhenMultiple: true,
      }),
    ).toBe("client-1");
  });

  it("requires a still-connected explicit choice when several computers are online", () => {
    const input = {
      clientIds: ["client-1", "client-2"],
      currentClientId: "client-1",
      requireExplicitWhenMultiple: true,
    };

    expect(resolveComputerSelection({ ...input, explicitlySelectedClientId: null })).toBeNull();
    expect(resolveComputerSelection({ ...input, explicitlySelectedClientId: "client-2" })).toBe("client-2");
    expect(resolveComputerSelection({ ...input, explicitlySelectedClientId: "disconnected" })).toBeNull();
  });

  it("preserves or supplies a selection for non-creation monitoring surfaces", () => {
    const input = {
      clientIds: ["newest", "older"],
      explicitlySelectedClientId: null,
      requireExplicitWhenMultiple: false,
    };

    expect(resolveComputerSelection({ ...input, currentClientId: "older" })).toBe("older");
    expect(resolveComputerSelection({ ...input, currentClientId: "disconnected" })).toBe("newest");
  });
});

describe("resolveRuntimeSelection", () => {
  it("preserves a still-ready manual choice", () => {
    expect(
      resolveRuntimeSelection({
        currentRuntime: "claude-code",
        selectionIsManual: true,
        readyRuntimes: ["codex", "claude-code"],
      }),
    ).toEqual({ runtime: "claude-code", selectionIsManual: true });
  });

  it("reapplies catalog order when the previous choice was automatic", () => {
    expect(
      resolveRuntimeSelection({
        currentRuntime: "claude-code",
        selectionIsManual: false,
        readyRuntimes: ["codex", "claude-code"],
      }),
    ).toEqual({ runtime: "codex", selectionIsManual: false });
  });

  it("falls back when a manual choice is unavailable on the selected computer", () => {
    expect(
      resolveRuntimeSelection({
        currentRuntime: "claude-code",
        selectionIsManual: true,
        readyRuntimes: ["codex", "opencode"],
      }),
    ).toEqual({ runtime: "codex", selectionIsManual: false });
  });

  it("keeps the current value while no runtime is ready", () => {
    expect(
      resolveRuntimeSelection({
        currentRuntime: "codex",
        selectionIsManual: true,
        readyRuntimes: [],
      }),
    ).toEqual({ runtime: "codex", selectionIsManual: false });
  });
});
