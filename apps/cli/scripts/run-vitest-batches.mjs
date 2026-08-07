#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const testRoots = ["src/__tests__", "tests"];
export const singletonFiles = new Set([
  "src/__tests__/client-runtime-context-tree.test.ts",
  "src/__tests__/login-command.test.ts",
  "src/__tests__/service-install-core.test.ts",
  "src/__tests__/task-scheduler-operations.test.ts",
  "src/__tests__/update-portable-install.test.ts",
  "tests/context-policy-runtime-layout.test.ts",
  "tests/portable-s3-scripts.test.ts",
]);

const batchSize = Number.parseInt(process.env.FIRST_TREE_CLI_TEST_BATCH_SIZE ?? "8", 10);
const maxBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 8;
const passthroughArgs = process.argv.slice(2);
const vitestBin = process.platform === "win32" ? "vitest.cmd" : "vitest";

function hasGitAncestor(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function resolveTempRoot() {
  const candidates = [
    process.env.FIRST_TREE_CLI_TEST_TMPDIR,
    process.env.RUNNER_TEMP,
    join(homedir(), ".cache", "first-tree", "cli-tests"),
    tmpdir(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      if (!hasGitAncestor(candidate)) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return tmpdir();
}

export function listTestFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => join(root, entry.name).replaceAll("\\", "/"));
}

export function chunk(files, size) {
  const chunks = [];
  for (let index = 0; index < files.length; index += size) {
    chunks.push(files.slice(index, index + size));
  }
  return chunks;
}

export function parseShard(value) {
  if (value === undefined || value.trim() === "") {
    return { index: 1, total: 1 };
  }
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`FIRST_TREE_CLI_TEST_SHARD must use <index>/<total>, received: ${value}`);
  }
  const index = Number.parseInt(match[1], 10);
  const total = Number.parseInt(match[2], 10);
  if (index < 1 || total < 1 || index > total) {
    throw new Error(`FIRST_TREE_CLI_TEST_SHARD must satisfy 1 <= index <= total, received: ${value}`);
  }
  return { index, total };
}

function stableFileRank(file) {
  return createHash("sha256").update(file).digest("hex");
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function partitionTestFiles(files, total) {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`shard total must be a positive integer, received: ${total}`);
  }
  const partitions = Array.from({ length: total }, () => []);
  const ranked = [...files].sort((left, right) => {
    const rankOrder = compareText(stableFileRank(left), stableFileRank(right));
    return rankOrder === 0 ? compareText(left, right) : rankOrder;
  });
  for (const [index, file] of ranked.entries()) {
    partitions[index % total].push(file);
  }
  return partitions.map((partition) => partition.sort(compareText));
}

export function selectTestFilesForShard(files, shard) {
  return partitionTestFiles(files, shard.total)[shard.index - 1];
}

export function createBatches(files, size) {
  const singletonBatches = files.filter((file) => singletonFiles.has(file)).map((file) => [file]);
  const remainingBatches = chunk(
    files.filter((file) => !singletonFiles.has(file)),
    size,
  );
  return [...singletonBatches, ...remainingBatches];
}

export function createTestPlan(files, size, shardValue) {
  const shard = parseShard(shardValue);
  const selectedFiles = selectTestFilesForShard(files, shard);
  return {
    shard,
    files: selectedFiles,
    batches: createBatches(selectedFiles, size),
  };
}

export function main() {
  const discoveredFiles = testRoots.flatMap(listTestFiles).sort();
  const plan = createTestPlan(discoveredFiles, maxBatchSize, process.env.FIRST_TREE_CLI_TEST_SHARD);
  const baseTempRoot = resolveTempRoot();
  const tempRoot = join(baseTempRoot, `shard-${plan.shard.index}-of-${plan.shard.total}`);
  mkdirSync(tempRoot, { recursive: true });

  for (const [index, files] of plan.batches.entries()) {
    console.error(
      `[first-tree-dev test] shard ${plan.shard.index}/${plan.shard.total} batch ${index + 1}/${plan.batches.length}: ${files.length} file${files.length === 1 ? "" : "s"}`,
    );
    const result = spawnSync(vitestBin, ["run", "--passWithNoTests", ...passthroughArgs, ...files], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEMP: tempRoot,
        TMP: tempRoot,
        TMPDIR: tempRoot,
        VITEST_MAX_FORKS: process.env.VITEST_MAX_FORKS ?? "1",
      },
      stdio: "inherit",
    });
    if (result.error) {
      console.error(result.error.message);
      process.exitCode = 1;
      return;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main();
}
