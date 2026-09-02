import { describe, expect, it } from "vitest";

import { formatTokenCount, processedTokenCount } from "../token-usage";

describe("native token usage", () => {
  it("counts processed tokens exactly like web", () => {
    expect(processedTokenCount({ inputTokens: 100, cachedInputTokens: 250, outputTokens: 50 })).toBe(400);
    expect(processedTokenCount({ inputTokens: 100, outputTokens: 50 })).toBe(150);
  });

  it("formats compact mobile-safe values", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});
