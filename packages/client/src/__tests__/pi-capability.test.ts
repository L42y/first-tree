import { describe, expect, it, vi } from "vitest";
import { probePiCapability } from "../runtime/capabilities/pi.js";
import { PI_INSTALL_COMMAND } from "../runtime/pi-binary.js";

describe("probePiCapability — install-only detection", () => {
  it("resolved binary → ok with runtimeSource=path (existence only, never launched)", async () => {
    const entry = await probePiCapability({ findOnPath: () => "/home/op/.local/bin/pi" });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/home/op/.local/bin/pi",
    });
  });

  it("nothing resolved → missing with the official installer in the reason", async () => {
    const entry = await probePiCapability({ findOnPath: () => null });
    expect(entry).toMatchObject({ state: "missing", available: false });
    expect(entry.error).toContain(PI_INSTALL_COMMAND);
  });

  it("win32 → state error fail-closed WITHOUT consulting the filesystem", async () => {
    const findOnPath = vi.fn(() => "/fake/pi");
    const entry = await probePiCapability({ platform: "win32", findOnPath });
    expect(entry).toMatchObject({ state: "error", available: false });
    expect(entry.error).toContain("not supported on Windows in V1");
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it("a throwing resolver → error entry, never a rejection", async () => {
    const entry = await probePiCapability({
      findOnPath: () => {
        throw new Error("resolver blew up");
      },
    });
    expect(entry).toMatchObject({ state: "error", available: false, error: "resolver blew up" });
  });
});
