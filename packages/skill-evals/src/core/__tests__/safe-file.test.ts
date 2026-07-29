import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { entryExistsNoFollowBeneath, readNoFollowRegularTextBeneath } from "../safe-file.js";

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
        "Trusted-root open rejected",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps the final open beneath an already-open parent when its pathname is swapped", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-evals-safe-file-"));
    try {
      const trusted = join(root, "trusted");
      const nested = join(trusted, "nested");
      const originalNested = join(trusted, "nested-original");
      const outside = join(root, "outside");
      const marker = join(root, "parents-opened");
      const resume = join(root, "resume-open");
      mkdirSync(nested, { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(nested, "value.txt"), "safe\n", "utf8");
      writeFileSync(join(outside, "value.txt"), "external\n", "utf8");

      const swapper = spawn(process.execPath, [
        "-e",
        [
          'const { existsSync, renameSync, symlinkSync, writeFileSync } = require("node:fs");',
          "const [marker, nested, originalNested, outside, resume] = process.argv.slice(1);",
          "const sleep = new Int32Array(new SharedArrayBuffer(4));",
          "while (!existsSync(marker)) Atomics.wait(sleep, 0, 0, 5);",
          "renameSync(nested, originalNested);",
          "symlinkSync(outside, nested);",
          'writeFileSync(resume, "", "utf8");',
        ].join("\n"),
        marker,
        nested,
        originalNested,
        outside,
        resume,
      ]);
      const swapperExit =
        swapper.exitCode === null ? once(swapper, "exit") : Promise.resolve<[number | null]>([swapper.exitCode]);

      const contents = readNoFollowRegularTextBeneath(trusted, join(nested, "value.txt"), 1024, {
        afterParentsOpenedPath: marker,
        resumeAfterSwapPath: resume,
      });
      const [exitCode] = await swapperExit;

      expect(exitCode).toBe(0);
      expect(contents).toBe("safe\n");
      expect(readFileSync(join(nested, "value.txt"), "utf8")).toBe("external\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("observes a final symlink entry without following its target", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-evals-safe-file-"));
    try {
      const outside = join(root, "outside");
      mkdirSync(outside);
      const link = join(root, "context-tree");
      symlinkSync(outside, link);

      expect(entryExistsNoFollowBeneath(root, link)).toBe(true);
      rmSync(outside, { recursive: true });
      expect(entryExistsNoFollowBeneath(root, link)).toBe(true);
      unlinkSync(link);
      expect(entryExistsNoFollowBeneath(root, link)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
