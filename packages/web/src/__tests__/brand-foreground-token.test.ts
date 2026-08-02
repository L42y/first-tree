import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexCss = readFileSync(new URL("../index.css", import.meta.url), "utf8");

/**
 * Brand-foreground token contract (WCAG AA on the brand green).
 *
 * The near-white `--fg-on-vivid` measures ~2.2:1 on `--brand`, so brand-filled
 * primary actions must use the near-black `--fg-on-brand` instead. This test
 * pins the token wiring — the alias, and the `.landing-marketing` scope where
 * `--primary` is re-pointed at `--brand` — so a future edit cannot silently
 * re-pair a marketing primary action with white-on-green. Real contrast
 * verification (axe) stays with the shipped-surface QA gate; this guards the
 * semantic binding, not a hardcoded page hex.
 */
describe("brand foreground token contract", () => {
  it("defines a dedicated on-brand foreground distinct from --fg-on-vivid", () => {
    expect(indexCss).toMatch(/--fg-on-brand:\s*oklch\(0\.17 0 0\)/);
    expect(indexCss).toMatch(/--fg-on-vivid:\s*oklch\(0\.985 0 0\)/);
  });

  it("exposes the brand foreground as a Tailwind color alias", () => {
    expect(indexCss).toContain("--color-brand-foreground: var(--fg-on-brand);");
  });

  it("points the marketing scope's primary-on at the brand foreground", () => {
    const marketingScope = indexCss.slice(indexCss.indexOf(".landing-marketing {"));
    const primaryOn = marketingScope.indexOf("--primary-on:");
    expect(primaryOn).toBeGreaterThan(-1);
    const declaration = marketingScope.slice(primaryOn, marketingScope.indexOf(";", primaryOn) + 1);
    expect(declaration).toBe("--primary-on: var(--fg-on-brand);");
  });

  it("keeps --fg-on-vivid available for the other vivid surfaces", () => {
    // Avatars/badges/overlays still use the near-white on-color; only the
    // brand-green pair moved.
    expect(indexCss).toContain("color: var(--fg-on-vivid);");
  });
});
