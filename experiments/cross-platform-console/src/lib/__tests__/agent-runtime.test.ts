import { describe, expect, it } from "vitest";

import {
  type AgentRuntimeSummary,
  agentActivity,
  canToggleAgentRun,
  effortLabel,
  modelLabel,
  providerLabel,
  summarizeRuntimeConfig,
} from "../agent-runtime";

const summary = (overrides: Partial<AgentRuntimeSummary> = {}): AgentRuntimeSummary => ({
  provider: "claude-code",
  model: null,
  effort: null,
  ...overrides,
});

describe("agent runtime summary", () => {
  it("names the model, falling back to the runtime when none is configured", () => {
    expect(modelLabel(summary({ model: "claude-opus-5" }))).toBe("claude-opus-5");
    // An empty model means the runtime's own default, so name the runtime.
    expect(modelLabel(summary({ model: "" }))).toBe("Claude Code");
    expect(modelLabel(summary({ model: null, provider: "codex" }))).toBe("Codex");
    // Unknown providers print their raw id rather than disappearing.
    expect(providerLabel("some-new-runtime")).toBe("some-new-runtime");
    expect(modelLabel(summary({ provider: null }))).toBeNull();
  });

  it("shows effort only when one was actually chosen", () => {
    expect(effortLabel(summary({ effort: "high" }))).toBe("high");
    // "" is the inherit sentinel — nothing was chosen, so there is nothing to show.
    expect(effortLabel(summary({ effort: "" }))).toBeNull();
    expect(effortLabel(summary())).toBeNull();
  });

  it("reads model and effort out of any provider variant", () => {
    expect(summarizeRuntimeConfig({ kind: "codex", model: "gpt-5", reasoningEffort: "xhigh" }, "codex")).toEqual({
      provider: "codex",
      model: "gpt-5",
      effort: "xhigh",
    });
    // Cursor has no effort channel at all.
    expect(summarizeRuntimeConfig({ kind: "cursor", model: "" }, "cursor")).toEqual({
      provider: "cursor",
      model: "",
      effort: null,
    });
    expect(summarizeRuntimeConfig(undefined, null)).toEqual({ provider: null, model: null, effort: null });
  });

  it("ranks activity so a paused agent never reads as busy", () => {
    // Paused wins over any presence the agent last reported.
    expect(agentActivity(summary({ status: "suspended", runtimeState: "working" }))?.key).toBe("paused");
    expect(agentActivity(summary({ status: "active", runtimeState: "working" }))?.key).toBe("working");
    expect(agentActivity(summary({ runtimeState: "blocked" }))?.label).toBe("Blocked");
    expect(agentActivity(summary({ runtimeState: "error" }))?.tone).toBe("danger");
    // Connected with no runtime state is idle; no presence at all is offline.
    expect(agentActivity(summary({ presenceStatus: "online" }))?.key).toBe("idle");
    expect(agentActivity(summary({ presenceStatus: "offline" }))?.key).toBe("offline");
    expect(agentActivity(undefined)).toBeNull();
  });

  it("offers pause/resume only to the agent's manager", () => {
    expect(canToggleAgentRun(summary({ managed: true }))).toBe(true);
    expect(canToggleAgentRun(summary({ managed: false }))).toBe(false);
    expect(canToggleAgentRun(undefined)).toBe(false);
  });
});
