import { describe, expect, it } from "vitest";
import { discoverAntigravityModels, parseAntigravityModelsOutput } from "../discover-models.js";

describe("parseAntigravityModelsOutput", () => {
  it("parses documented slug/label rows", () => {
    const parsed = parseAntigravityModelsOutput(`gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
`);
    expect(parsed.defaultModelId).toBeNull();
    expect(parsed.models).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    ]);
  });

  it("parses JSON catalogs and marks the default", () => {
    const parsed = parseAntigravityModelsOutput(
      JSON.stringify({
        defaultModelId: "gemini-3.8-flash-medium",
        models: [
          { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
          { slug: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", default: true },
        ],
      }),
    );
    expect(parsed.defaultModelId).toBe("gemini-3.8-flash-medium");
    expect(parsed.models).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      {
        id: "gemini-3.8-flash-medium",
        label: "Gemini 3.8 Flash (Medium)",
        isDefault: true,
        hint: "default",
      },
    ]);
  });
});

describe("discoverAntigravityModels", () => {
  it("returns the provider-cli catalog from agy models", async () => {
    const catalog = await discoverAntigravityModels({
      now: () => new Date("2026-09-18T00:00:00Z"),
      resolveAntigravityBinary: () => ({ ok: true, binary: "/fake/bin/agy" }),
      runAntigravityModels: async () => ({
        ok: true,
        stdout: "gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n",
        stderr: "",
      }),
    });
    expect(catalog).toEqual({
      provider: "antigravity",
      models: [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }],
      defaultModelId: null,
      fetchedAt: "2026-09-18T00:00:00.000Z",
      source: "provider-cli",
      error: null,
    });
  });

  it("degrades to unavailable when the binary is missing", async () => {
    const catalog = await discoverAntigravityModels({
      resolveAntigravityBinary: () => ({ ok: false, error: "no agy binary resolved on this host" }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.models).toEqual([]);
    expect(catalog.error).toContain("no agy binary");
  });

  it("degrades to unavailable when agy models returns no rows", async () => {
    const catalog = await discoverAntigravityModels({
      resolveAntigravityBinary: () => ({ ok: true, binary: "/fake/bin/agy" }),
      runAntigravityModels: async () => ({ ok: true, stdout: "Available models\n", stderr: "" }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.error).toContain("no parseable model rows");
  });
});
