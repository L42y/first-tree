import { describe, expect, it } from "vitest";
import { buildZcodeTurnArgs, inspectZcodeVersion, resolveZcodeRuntimeBinary } from "../binary.js";

const PINNED_VERSION_OUTPUT = "zcode-app-cli 3.10.2-18\nzcode-runtime 3.10.2-18";

describe("inspectZcodeVersion", () => {
  it("accepts only the exact wrapper and runtime pin", () => {
    expect(inspectZcodeVersion(PINNED_VERSION_OUTPUT)).toEqual({
      ok: true,
      wrapperVersion: "3.10.2-18",
      runtimeVersion: "3.10.2-18",
    });
  });

  it("rejects malformed or incompatible version contracts", () => {
    const malformed = inspectZcodeVersion("3.10.2-18");
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error("expected malformed version output to fail");
    expect(malformed.error).toContain("cannot verify");

    const incompatible = inspectZcodeVersion("zcode-app-cli 3.10.2-17\nzcode-runtime 3.10.2-18");
    expect(incompatible.ok).toBe(false);
    if (incompatible.ok) throw new Error("expected incompatible version output to fail");
    expect(incompatible.error).toContain("wrapper=3.10.2-17");
  });
});

describe("resolveZcodeRuntimeBinary", () => {
  it("admits the binary only after Node and both pinned components pass", async () => {
    await expect(
      resolveZcodeRuntimeBinary(
        { PATH: "/test" },
        {
          findOnPath: () => "/host/zcode",
          readVersion: async () => PINNED_VERSION_OUTPUT,
          nodeVersion: () => "22.19.0",
        },
      ),
    ).resolves.toEqual({ ok: true, binary: "/host/zcode" });
  });

  it("fails closed before invoking the launcher below the supported Node floor", async () => {
    const readVersion = async () => PINNED_VERSION_OUTPUT;
    await expect(
      resolveZcodeRuntimeBinary(
        { PATH: "/test" },
        {
          findOnPath: () => "/host/zcode",
          readVersion,
          nodeVersion: () => "22.18.9",
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringContaining("Node.js 22.19.0+"),
    });
  });
});

describe("buildZcodeTurnArgs", () => {
  it("builds one canonical no-shell turn invocation", () => {
    expect(
      buildZcodeTurnArgs({
        workspace: "/tmp/agent-workspace",
        prompt: 'first\n\nsay "ok" $(not-expanded)',
        mode: "plan",
        resumeSessionId: null,
      }),
    ).toEqual([
      "--json",
      "--no-color",
      "--mode",
      "plan",
      "--cwd",
      "/tmp/agent-workspace",
      "--prompt",
      'first\n\nsay "ok" $(not-expanded)',
    ]);
  });

  it("resumes only with the confirmed provider-owned session identity", () => {
    const args = buildZcodeTurnArgs({
      workspace: "/tmp/agent-workspace",
      prompt: "continue",
      mode: "edit",
      resumeSessionId: "sess_confirmed",
    });
    expect(args.slice(-2)).toEqual(["--resume", "sess_confirmed"]);
  });

  it("rejects an empty provider prompt", () => {
    expect(() =>
      buildZcodeTurnArgs({
        workspace: "/tmp/agent-workspace",
        prompt: " ",
        mode: "build",
        resumeSessionId: null,
      }),
    ).toThrow("ZCode turn prompt is empty");
  });
});
