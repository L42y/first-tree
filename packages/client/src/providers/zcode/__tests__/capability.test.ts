import { describe, expect, it } from "vitest";
import { probeZcodeCapability } from "../capability.js";

describe("probeZcodeCapability", () => {
  it("reports a resolved executable without inspecting provider credentials", async () => {
    await expect(
      probeZcodeCapability({
        findOnPath: () => "/opt/zcode/bin/zcode",
        readVersion: async () => "zcode-app-cli 3.10.2-18\nzcode-runtime 3.10.2-18",
        nodeVersion: () => "22.19.0",
      }),
    ).resolves.toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/opt/zcode/bin/zcode",
    });
  });

  it("fails closed on a wrong wrapper/runtime identity", async () => {
    const result = await probeZcodeCapability({
      findOnPath: () => "/host/zcode",
      readVersion: async () => "not-zcode 1.0.0\nzcode-runtime 3.10.2-18",
      nodeVersion: () => "22.19.0",
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("cannot verify the pinned ZCode wrapper/runtime contract");
  });

  it("fails closed on an incompatible pinned runtime", async () => {
    const result = await probeZcodeCapability({
      findOnPath: () => "/host/zcode",
      readVersion: async () => "zcode-app-cli 3.10.2-18\nzcode-runtime 3.10.2-17",
      nodeVersion: () => "22.19.0",
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("runtime=3.10.2-17");
  });

  it("fails closed below the wrapper's supported Node floor", async () => {
    const result = await probeZcodeCapability({
      findOnPath: () => "/host/zcode",
      readVersion: async () => "zcode-app-cli 3.10.2-18\nzcode-runtime 3.10.2-18",
      nodeVersion: () => "22.13.0",
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("Node.js 22.19.0+");
  });

  it("reports a missing executable as a permanent setup error", async () => {
    const result = await probeZcodeCapability({ findOnPath: () => null });
    expect(result.available).toBe(false);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("zcode-app-cli@3.10.2-18");
  });

  it("fails closed on Windows even when the executable resolves", async () => {
    const result = await probeZcodeCapability({
      findOnPath: () => "/host/zcode",
      readVersion: async () => "zcode-app-cli 3.10.2-18\nzcode-runtime 3.10.2-18",
      nodeVersion: () => "22.19.0",
      platform: "win32",
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe("error");
    expect(result.error).toContain("Job Object");
  });
});
