import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("mobile PWA manifest", () => {
  it("uses the canonical Chat route for identity and launch", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../../public/manifest.webmanifest", import.meta.url), "utf8"),
    ) as { id?: string; start_url?: string };

    expect(manifest.id).toBe("/m/chat");
    expect(manifest.start_url).toBe("/m/chat");
  });
});
