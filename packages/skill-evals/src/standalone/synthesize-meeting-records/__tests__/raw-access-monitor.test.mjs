import { describe, expect, it } from "vitest";

import { isProtectedPathMutation } from "../raw-access-monitor-lib.mjs";

describe("partial raw access pathname events", () => {
  it("fails closed for an unscoped rename callback", () => {
    expect(isProtectedPathMutation("rename", null, "appendix.md")).toBe(true);
    expect(isProtectedPathMutation("rename", undefined, "appendix.md")).toBe(true);
  });

  it("accepts only scoped non-rename events or unrelated rename names", () => {
    expect(isProtectedPathMutation("change", null, "appendix.md")).toBe(false);
    expect(isProtectedPathMutation("rename", "appendix.md", "appendix.md")).toBe(true);
    expect(isProtectedPathMutation("rename", "meeting-analysis-output.json", "source-artifacts")).toBe(false);
  });
});
