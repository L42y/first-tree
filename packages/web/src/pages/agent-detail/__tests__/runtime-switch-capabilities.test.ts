import type { CapabilityEntry } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import { runtimeSwitchAvailableProviders } from "../../agent-detail.js";

function capability(state: CapabilityEntry["state"]): CapabilityEntry {
  return {
    state,
    available: state === "ok",
    sdkVersion: null,
    detectedAt: new Date(0).toISOString(),
  };
}

function client(capabilities: HubClient["capabilities"]): HubClient {
  return {
    id: "client-win",
    userId: "user-1",
    status: "connected",
    authState: "ok",
    binName: "first-tree",
    sdkVersion: "0.5.18",
    hostname: "windows-host",
    os: "win32",
    agentCount: 0,
    connectedAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(),
    capabilities,
  };
}

describe("runtime switch capability filtering", () => {
  it("does not offer OpenCode when its installed Windows runtime is unavailable", () => {
    const available = runtimeSwitchAvailableProviders(
      client({
        codex: capability("ok"),
        opencode: {
          ...capability("error"),
          runtimePath: "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
          error: "installed but Windows execution is unsupported",
        },
      }),
    );

    expect(available).toContain("codex");
    expect(available).not.toContain("opencode");
  });

  it.each([null, "0.1.0"])("keeps provider capability independent of Client SDK version %s", (sdkVersion) => {
    const target = { ...client({ codex: capability("ok") }), sdkVersion };

    expect(runtimeSwitchAvailableProviders(target)).toContain("codex");
  });
});
