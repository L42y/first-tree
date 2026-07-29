import { type AgentRuntimeConfig, DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { ServiceUnavailableError } from "../errors.js";
import { RuntimeConfigSnapshotChangedError, resolveCurrentRuntimeConfig } from "../services/runtime-config-snapshot.js";

function config(version: number): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version,
    payload: { ...DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD },
    updatedAt: new Date(version).toISOString(),
    updatedBy: "member-1",
  };
}

describe("runtime config snapshot resolution", () => {
  it("reloads the base config when the Resource projection crosses a version fence", async () => {
    const loadConfig = vi.fn().mockResolvedValue(config(2));
    const resolveConfig = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeConfigSnapshotChangedError())
      .mockResolvedValueOnce(config(2));

    await expect(resolveCurrentRuntimeConfig(loadConfig, resolveConfig, config(1))).resolves.toMatchObject({
      version: 2,
    });
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(resolveConfig).toHaveBeenCalledTimes(2);
  });

  it("fails boundedly when config changes on every resolution attempt", async () => {
    const loadConfig = vi.fn().mockResolvedValue(config(2));
    const resolveConfig = vi.fn().mockRejectedValue(new RuntimeConfigSnapshotChangedError());

    await expect(resolveCurrentRuntimeConfig(loadConfig, resolveConfig, config(1))).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(resolveConfig).toHaveBeenCalledTimes(3);
  });
});
