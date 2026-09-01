import { describe, expect, it } from "vitest";
import { buildZcodeTurnArgs } from "../binary.js";

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
