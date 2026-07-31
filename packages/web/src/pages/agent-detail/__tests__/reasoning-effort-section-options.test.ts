import { describe, expect, it } from "vitest";
import { CODEX_EFFORT_OPTIONS, EFFORT_HELP_BY_PROVIDER } from "../reasoning-effort-section.js";

describe("grok reasoning effort help copy", () => {
  it("describes next-turn existing-session semantics (set_model), never new-sessions-only", () => {
    const copy = EFFORT_HELP_BY_PROVIDER.grok;
    expect(copy).not.toContain("Applies to new sessions");
    expect(copy).toContain("next turn");
    expect(copy).toContain("existing sessions");
    expect(copy).toContain("session/set_model");
  });

  it("unset removes only the effort override — it does not imply clearing an explicit model", () => {
    const copy = EFFORT_HELP_BY_PROVIDER.grok;
    expect(copy).toContain("removes only the effort override");
    expect(copy).toContain("explicit model is still re-applied");
    expect(copy).toContain("with model also unset");
  });
});

describe("Codex reasoning effort options", () => {
  it("orders the provider-native levels through max and ultra", () => {
    expect(CODEX_EFFORT_OPTIONS.map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("marks max and ultra as model-dependent", () => {
    expect(CODEX_EFFORT_OPTIONS.filter((option) => ["max", "ultra"].includes(option.value))).toEqual([
      { value: "max", label: "max", hint: "model-dependent" },
      { value: "ultra", label: "ultra", hint: "deepest; model-dependent" },
    ]);
  });
});
