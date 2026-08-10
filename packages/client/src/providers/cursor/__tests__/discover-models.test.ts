import { describe, expect, it } from "vitest";
import { parseCursorModelsOutput } from "../discover-models.js";

describe("parseCursorModelsOutput", () => {
  it("parses id/label rows and marks the default", () => {
    const parsed = parseCursorModelsOutput(`Available models

auto - Auto (default)
gpt-5.2 - GPT-5.2
composer-2.5 - Composer 2.5
`);
    expect(parsed.defaultModelId).toBe("auto");
    expect(parsed.models).toEqual([
      { id: "auto", label: "Auto", isDefault: true, hint: "default" },
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "composer-2.5", label: "Composer 2.5" },
    ]);
  });
});
