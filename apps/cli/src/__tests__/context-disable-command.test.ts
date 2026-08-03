import { describe, expect, it } from "vitest";
import { contextDisableCommand } from "../commands/context/disable.js";

describe("context disable v3 surface", () => {
  it("removes one exact persistent Team grant and keeps the shared Plugin", () => {
    expect(contextDisableCommand.description).toContain("one exact persistent BYO Team grant");
  });
});
