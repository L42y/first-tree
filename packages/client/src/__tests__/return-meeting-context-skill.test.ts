import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

describe("return-meeting-context shipped skill", () => {
  it("passes its deterministic artifact, chronology, settlement, privacy, and handoff gates", () => {
    const root = repoRoot();
    const output = execFileSync(
      process.execPath,
      [join(root, "skills", "return-meeting-context", "scripts", "test.mjs")],
      {
        cwd: join(root, "skills", "return-meeting-context"),
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(output).toContain("return-meeting-context deterministic tests passed");
  }, 30_000);
});
