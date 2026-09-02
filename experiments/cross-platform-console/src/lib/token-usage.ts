type TokenUsageParts = {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
};

function tokenPart(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function processedTokenCount(usage: TokenUsageParts): number {
  return tokenPart(usage.inputTokens) + tokenPart(usage.cachedInputTokens) + tokenPart(usage.outputTokens);
}

/** Matches the web marker's compact format: 1234 → 1.2k, 2,500,000 → 2.5M. */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
