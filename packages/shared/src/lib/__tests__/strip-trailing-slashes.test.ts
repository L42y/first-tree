import { describe, expect, it } from "vitest";
import { stripTrailingSlashes } from "../strip-trailing-slashes.js";

describe("stripTrailingSlashes", () => {
  it("removes one or more trailing slashes", () => {
    expect(stripTrailingSlashes("https://first-tree.example/")).toBe("https://first-tree.example");
    expect(stripTrailingSlashes("https://first-tree.example///")).toBe("https://first-tree.example");
  });

  it("leaves URLs without trailing slashes unchanged", () => {
    expect(stripTrailingSlashes("https://first-tree.example")).toBe("https://first-tree.example");
  });

  it("completes quickly on adversarial trailing-slash input", () => {
    const input = `https://first-tree.example${"/".repeat(5000)}`;
    const started = performance.now();
    expect(stripTrailingSlashes(input)).toBe("https://first-tree.example");
    expect(performance.now() - started).toBeLessThan(100);
  });
});
