import { describe, expect, it } from "vitest";
import { probeZcodeCapability } from "../capability.js";

describe("probeZcodeCapability", () => {
  it("reports a resolved executable without inspecting provider credentials", async () => {
    await expect(probeZcodeCapability({ findOnPath: () => "/opt/zcode/bin/zcode" })).resolves.toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/opt/zcode/bin/zcode",
    });
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
      platform: "win32",
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe("error");
    expect(result.error).toContain("Job Object");
  });
});
