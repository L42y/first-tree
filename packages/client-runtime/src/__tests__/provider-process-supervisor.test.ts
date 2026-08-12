import { describe, expect, it } from "vitest";
import {
  createDefaultProviderProcessSupervisor,
  ProviderProcessSupervisionUnsupportedError,
  supportsDefaultProviderProcessSupervision,
} from "../runtime/provider-process-supervisor.js";

describe("provider process supervisor", () => {
  it("fails closed on Windows until a pre-admission Job Object supervisor is supplied", () => {
    expect(supportsDefaultProviderProcessSupervision("win32")).toBe(false);
    expect(supportsDefaultProviderProcessSupervision("darwin")).toBe(true);
    expect(supportsDefaultProviderProcessSupervision("linux")).toBe(true);
    const supervisor = createDefaultProviderProcessSupervisor("win32");

    expect(() =>
      supervisor.spawn({
        command: "opencode.exe",
        args: ["run"],
        label: "test",
        options: { stdio: "ignore" },
      }),
    ).toThrow(ProviderProcessSupervisionUnsupportedError);
  });
});
