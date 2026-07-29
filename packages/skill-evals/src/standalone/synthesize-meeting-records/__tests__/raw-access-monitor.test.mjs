import { describe, expect, it } from "vitest";

import { isProtectedPathMutation } from "../raw-access-monitor-lib.mjs";

describe("partial raw access pathname events", () => {
  it("fails closed for an unscoped rename callback", () => {
    expect(isProtectedPathMutation("rename", null, "appendix.md")).toBe(true);
    expect(isProtectedPathMutation("rename", undefined, "appendix.md")).toBe(true);
  });

  it("fails closed for scoped or unscoped metadata changes", () => {
    expect(isProtectedPathMutation("change", null, "appendix.md")).toBe(true);
    expect(isProtectedPathMutation("change", undefined, "appendix.md")).toBe(true);
    expect(isProtectedPathMutation("change", "appendix.md", "appendix.md")).toBe(true);
    expect(isProtectedPathMutation("change", "minutes.md", "appendix.md")).toBe(false);
  });

  it("accepts only unrelated rename names or unsupported events", () => {
    expect(isProtectedPathMutation("rename", "appendix.md", "appendix.md")).toBe(true);
    expect(isProtectedPathMutation("rename", "meeting-analysis-output.json", "source-artifacts")).toBe(false);
    expect(isProtectedPathMutation("unsupported", null, "appendix.md")).toBe(false);
  });
});
