import { describe, expect, it } from "vitest";
import { sourceLabel } from "../resource-source.js";

describe("sourceLabel", () => {
  it("distinguishes official Agent Template resources from consumer Team resources", () => {
    expect(sourceLabel("agent_template")).toBe("From an official Agent Template");
    expect(sourceLabel("team_recommended")).toBe("From your team");
    expect(sourceLabel("team_available")).toBe("From your team · optional");
    expect(sourceLabel("agent_extra")).toBe("Added by you");
  });
});
