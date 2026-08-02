import { describe, expect, it } from "vitest";
import { sourceLabel, templateSourceLabel } from "../resource-source.js";

describe("resource source labels", () => {
  it("keeps ordinary source labels unchanged", () => {
    expect(sourceLabel("agent_extra")).toBe("Added by you");
    expect(sourceLabel("inline_prompt")).toBe("Added by you");
    expect(sourceLabel("team_available")).toBe("From your team · optional");
    expect(sourceLabel("team_recommended")).toBe("From your team");
  });

  it("labels Template-imported resources with the Template name when known", () => {
    expect(templateSourceLabel("PR Engineer")).toBe("Imported from PR Engineer · maintained by your team");
  });

  it("falls back to non-leaking generic copy when the Template is unknown", () => {
    expect(templateSourceLabel(null)).toBe("Imported from a template · maintained by your team");
  });
});
