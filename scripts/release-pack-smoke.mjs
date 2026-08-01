#!/usr/bin/env node
/**
 * Release-pack smoke: prove the public npm packaging boundary works for the
 * built CLI under the trusted-publishing npm client the workflow pins.
 *
 *   1. `npm pack` the built apps/cli package through REAL pack semantics
 *      (prepack copies skills, postpack cleans up — no --ignore-scripts).
 *   2. Install the tarball into an empty consumer with plain npm.
 *   3. Run the public CLI (`--version`).
 *   4. Resolve the bundled `@botiverse/kimi-code-sdk` from the consumer and
 *      assert the patched sites this PR ships: create-time drain flag, resume
 *      option threading, resume main-agent flag application, and the awaited
 *      replay-fence authorization hook.
 *
 * No registry publish, no credentials, no network beyond npm itself.
 * Everything happens in a disposable temp directory removed on exit.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CLI_ROOT = join(REPO_ROOT, "apps", "cli");

function fail(message) {
  console.error(`release-pack-smoke: FAIL: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} exited ${result.status}\n${detail}`);
  }
  return result;
}

if (!existsSync(join(CLI_ROOT, "dist", "cli", "index.mjs")) || !existsSync(join(CLI_ROOT, "dist", "index.mjs"))) {
  fail("apps/cli/dist is missing — run `pnpm build` first");
}

const work = mkdtempSync(join(tmpdir(), "first-tree-release-pack-smoke-"));
try {
  const consumerDir = join(work, "consumer");
  run("npm", ["pack", "--json"], { cwd: CLI_ROOT });
  const tarballs = readdirSync(CLI_ROOT)
    .filter((name) => /^first-tree-dev-.*\.tgz$/.test(name))
    .map((name) => join(CLI_ROOT, name));
  if (tarballs.length !== 1) fail(`expected exactly one first-tree-dev tarball in apps/cli, got ${tarballs.length}`);
  const tarball = tarballs[0];
  const tarballName = tarballs[0].split("/").pop();
  try {
    run("npm", ["install", "--prefix", consumerDir, tarball]);
    const binName = "first-tree-dev";
    const binPath = join(consumerDir, "node_modules", ".bin", binName);
    if (!existsSync(binPath)) fail(`consumer is missing ${binPath}`);
    const version = run(binPath, ["--version"]);
    const versionText = version.stdout.trim();
    if (!/^\d+\.\d+\.\d+/.test(versionText)) fail(`unexpected --version output: ${versionText}`);

    const sdkEntry = join(
      consumerDir,
      "node_modules",
      "first-tree-dev",
      "node_modules",
      "@botiverse",
      "kimi-code-sdk",
      "dist",
      "index.mjs",
    );
    if (!existsSync(sdkEntry)) {
      fail(`consumer did not resolve the bundled Kimi SDK at ${sdkEntry} — bundleDependencies is not shipping`);
    }
    const source = readFileSync(sdkEntry, "utf8");
    const requiredSites = [
      ["create drain flag", "if (this.options.drainAgentTasksOnStop) agent.printDrainAgentTasksOnStop = true"],
      ["resume option threading", "drainAgentTasksOnStop: input.drainAgentTasksOnStop"],
      ["resume main-agent flag", "this.options.drainAgentTasksOnStop) main.printDrainAgentTasksOnStop = true"],
      ["awaited replay-fence authorization hook", "__firstTreeBeforeToolCall"],
    ];
    for (const [label, needle] of requiredSites) {
      if (!source.includes(needle)) fail(`bundled Kimi SDK is missing the ${label} site`);
    }

    run(process.execPath, [
      "-e",
      `import(${JSON.stringify(`file://${sdkEntry}`)}).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); })`,
    ]);

    console.log(
      `release-pack-smoke: PASS — packed ${tarballName}, consumer CLI ${versionText}, bundled patched Kimi SDK verified`,
    );
  } finally {
    // Real pack semantics write the tarball into the package dir; never
    // leave it in the repo.
    rmSync(tarball, { force: true });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
