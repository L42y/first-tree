import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const CI_PATH = resolve(REPO_ROOT, ".github/workflows/ci.yml");
const ciText = readFileSync(CI_PATH, "utf8");
const workflow = parse(ciText);

function matchesPath(path, pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === pattern;
}

function cliPatterns() {
  const filterStep = workflow.jobs.changes.steps.find((step) => step.id === "filter");
  const filters = parse(filterStep.with.filters);
  return filters.cli;
}

describe("CLI CI trigger contract", () => {
  it("runs CLI shards for the conservative dependency matrix and skips unrelated packages", () => {
    const patterns = cliPatterns();
    const matrix = [
      ["apps/cli/src/index.ts", true],
      ["packages/client-runtime/src/index.ts", true],
      ["packages/shared/src/index.ts", true],
      ["skills/first-tree-read/SKILL.md", true],
      ["scripts/vitest-max-forks.ts", true],
      ["patches/@botiverse__kimi.patch", true],
      ["package.json", true],
      ["pnpm-lock.yaml", true],
      ["pnpm-workspace.yaml", true],
      ["tsconfig.json", true],
      ["tsconfig.base.json", true],
      ["turbo.json", true],
      [".github/workflows/ci.yml", true],
      ["packages/server/src/app.ts", false],
      ["packages/web/src/main.tsx", false],
      ["packages/skill-evals/src/index.ts", false],
      ["docs/cli-reference.md", false],
    ];

    expect(patterns).not.toContain("apps/**");
    expect(patterns).not.toContain("packages/**");
    for (const [path, expected] of matrix) {
      expect(
        patterns.some((pattern) => matchesPath(path, pattern)),
        path,
      ).toBe(expected);
    }
  });

  it("uses exactly two deterministic shards whose value participates in the Turbo test hash", () => {
    const cliJob = workflow.jobs.test_cli;
    const shardExpression = "$" + "{{ matrix.shard }}/2";
    expect(cliJob.if).toBe("needs.changes.outputs.cli == 'true'");
    expect(cliJob.strategy.matrix.shard).toEqual([1, 2]);
    expect(cliJob.env.FIRST_TREE_CLI_TEST_SHARD).toBe(shardExpression);
    expect(cliJob.env.VITEST_MAX_FORKS).toBe("1");
    expect(ciText).toContain("pnpm exec turbo run test --filter=first-tree-dev --concurrency=1");
    expect(ciText).not.toMatch(/FIRST_TREE_CLI_TEST_BATCH_SIZE:\s*(9|[1-9]\d+)/);

    const turbo = JSON.parse(readFileSync(resolve(REPO_ROOT, "apps/cli/turbo.json"), "utf8"));
    expect(turbo.tasks.test.env).toContain("FIRST_TREE_CLI_TEST_SHARD");
  });

  it("keeps release smoke at its original cadence and gates intentional shard skips", () => {
    const smoke = workflow.jobs.test_cli_release_smoke;
    expect(smoke.if).toBe("needs.changes.outputs.code == 'true' || github.event_name == 'push'");
    expect(smoke.steps.some((step) => step.name?.startsWith("Release pack smoke"))).toBe(true);
    expect(
      smoke.steps.some(
        (step) => step.run === "node scripts/release-pack-smoke.mjs selftest-turbo-context-integration-cache",
      ),
    ).toBe(true);
    expect(
      ciText.match(/node scripts\/release-pack-smoke\.mjs selftest-turbo-context-integration-cache/g),
    ).toHaveLength(1);

    const gate = workflow.jobs.test;
    expect(gate.if).toContain("needs.changes.outputs.cli == 'true'");
    expect(gate.needs).toEqual(
      expect.arrayContaining(["changes", "test_server", "test_client_web", "test_cli", "test_cli_release_smoke"]),
    );
    const gateScript = gate.steps.find((step) => step.name === "Verify parallel test jobs").run;
    expect(gateScript).toContain('require_result "Test Server" "$SERVER_RESULT" "$CODE_REQUIRED"');
    expect(gateScript).toContain('require_result "Test Client & Web" "$CLIENT_WEB_RESULT" "$CODE_REQUIRED"');
    expect(gateScript).toContain('require_result "Test CLI" "$CLI_RESULT" "$CLI_REQUIRED"');
    expect(gateScript).toContain(
      'require_result "Test CLI Release Smoke" "$CLI_RELEASE_SMOKE_RESULT" "$CODE_REQUIRED"',
    );
  });
});
