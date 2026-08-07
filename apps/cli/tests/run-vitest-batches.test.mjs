import { describe, expect, it } from "vitest";
import {
  createTestPlan,
  parseShard,
  partitionTestFiles,
  selectTestFilesForShard,
  singletonFiles,
} from "../scripts/run-vitest-batches.mjs";

describe("CLI Vitest shard planning", () => {
  it("defaults to one shard and rejects malformed shard selectors", () => {
    expect(parseShard(undefined)).toEqual({ index: 1, total: 1 });
    expect(parseShard(" 2/3 ")).toEqual({ index: 2, total: 3 });
    for (const invalid of ["", "1", "0/2", "3/2", "1/0", "left/right"]) {
      if (invalid === "") {
        expect(parseShard(invalid)).toEqual({ index: 1, total: 1 });
      } else {
        expect(() => parseShard(invalid)).toThrow(/FIRST_TREE_CLI_TEST_SHARD/);
      }
    }
  });

  it("partitions every file exactly once, independent of discovery order", () => {
    const files = Array.from({ length: 31 }, (_, index) => `src/__tests__/fixture-${index}.test.ts`);
    const partitions = partitionTestFiles(files, 2);

    expect(partitions).toEqual(partitionTestFiles([...files].reverse(), 2));
    expect(Math.abs(partitions[0].length - partitions[1].length)).toBeLessThanOrEqual(1);
    expect(partitions.flat().sort()).toEqual([...files].sort());
    expect(new Set(partitions.flat()).size).toBe(files.length);
    expect(() => partitionTestFiles(files, 0)).toThrow(/positive integer/);
  });

  it("builds two deterministic, disjoint plans while preserving bounded and singleton batches", () => {
    const heavy = [...singletonFiles];
    const ordinary = Array.from({ length: 41 }, (_, index) => `src/__tests__/ordinary-${index}.test.ts`);
    const files = [...heavy, ...ordinary].sort();
    const first = createTestPlan(files, 8, "1/2");
    const second = createTestPlan(files, 8, "2/2");

    expect(first.files).toEqual(selectTestFilesForShard(files, { index: 1, total: 2 }));
    expect(second.files).toEqual(selectTestFilesForShard(files, { index: 2, total: 2 }));
    expect([...first.files, ...second.files].sort()).toEqual(files);
    expect(first.files.filter((file) => second.files.includes(file))).toEqual([]);

    for (const plan of [first, second]) {
      expect(plan.batches.every((batch) => batch.length >= 1 && batch.length <= 8)).toBe(true);
      for (const singleton of plan.files.filter((file) => singletonFiles.has(file))) {
        expect(plan.batches).toContainEqual([singleton]);
      }
    }
  });
});
