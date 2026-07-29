import { describe, expect, it } from "vitest";
import {
  createDefaultProviderProcessSupervisor,
  ProviderProcessSupervisionUnsupportedError,
} from "../runtime/provider-process-supervisor.js";

describe("provider process supervisor", () => {
  it("fails closed on Windows until a pre-admission Job Object supervisor is supplied", () => {
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
