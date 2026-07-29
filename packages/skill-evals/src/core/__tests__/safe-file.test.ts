import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { readNoFollowRegularTextBeneath } from "../safe-file.js";

describe("trusted-root file snapshots", () => {
  it("reads a standalone regular file beneath ordinary directory components", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-evals-safe-file-"));
    try {
      const directory = join(root, "nested");
      mkdirSync(directory);
      const path = join(directory, "value.txt");
      writeFileSync(path, "safe\n", "utf8");

      expect(readNoFollowRegularTextBeneath(root, path)).toBe("safe\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a regular file reached through a symlinked ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-evals-safe-file-"));
    try {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "value.txt"), "external\n", "utf8");
      const trusted = join(root, "trusted");
      mkdirSync(trusted);
      symlinkSync(outside, join(trusted, "nested"));

      expect(() => readNoFollowRegularTextBeneath(trusted, join(trusted, "nested", "value.txt"))).toThrow(
        "Refusing unsafe path component",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
