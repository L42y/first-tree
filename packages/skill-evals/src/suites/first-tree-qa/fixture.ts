import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { appendEvent } from "../../core/events.js";
import type { EvalReporter } from "../../core/reporter.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { RunPaths } from "../../core/types.js";
import type { FirstTreeQaEvalCase, FixtureValidation } from "./types.js";

const SKILL_NAME = "first-tree-qa";

function workspaceAgentsMarkdown(skillDescription: string): string {
  return [
    "# First Tree QA Eval Workspace",
    "",
    "This workspace contains one product repository at `source-repo/`. Treat that",
    "repository as the immutable product under test. Put all run context, plans,",
    "evidence, and reports in the sibling `qa-artifacts/` directory.",
    "",
    "## Available Skills",
    "",
    "| Skill | Load when |",
    "|---|---|",
    `| \`first-tree-qa\` | ${skillDescription} |`,
    "",
    "When `first-tree-qa` applies, read",
    "`.agents/skills/first-tree-qa/SKILL.md` before acting.",
    "",
  ].join("\n");
}

function productReadme(mode: FirstTreeQaEvalCase["fixture"]["mode"]): string {
  const shared = [
    "# Northstar",
    "",
    "Northstar ships two formal product surfaces: a command-line client and a web",
    "console.",
    "",
    "Do not edit this repository while validating it.",
    "",
  ];
  if (mode === "test-only") {
    return [
      ...shared,
      "## Requested deterministic validation",
      "",
      "The repository-wide deterministic integration command is:",
      "",
      "    pnpm test",
      "",
      "It covers the requested status process boundary.",
      "",
      "This request does not need product startup, a capability matrix, a QA plan,",
      "or release qualification. Report the selected tier and why deterministic tests",
      "are sufficient, then limit the maximum conclusion to the reported automated checks.",
      "",
    ].join("\n");
  }
  if (mode === "focused-local") {
    return [
      ...shared,
      "## Requested focused local validation",
      "",
      "This is ordinary CLI feature validation, not release or major-feature qualification.",
      "A compatible QA-owned warm task slot already exists for this task; reuse it and",
      "do not tear down its healthy infrastructure after reporting.",
      "The dependency-free local capability command is:",
      "",
      "    node tools/product.mjs harness <cli|web> <build|run|drive|observe|measure|reset>",
      "",
      "It exits non-zero when a capability is unavailable and prints a latency sample.",
      "Start only the CLI surface locally and establish its six capabilities before",
      "planning and running the status task. Do not initialize the Web surface.",
      "",
      "A healthy operator-owned dependency is already running locally. It is read-only",
      "for this run. Inventory its owner, config, state, and health before any capability",
      "that uses it:",
      "",
      "    node tools/product.mjs shared inspect",
      "",
      "Do not mutate or replace that shared dependency. After inspection, use the CLI",
      "harness commands above, create a focused plan, and exercise:",
      "",
      "    node tools/product.mjs task cli status",
      "",
      "Report the focused-local rationale, shared-state handling and non-isolation limit.",
      "The maximum conclusion is only the observed CLI path under these local conditions,",
      "not Web behavior or release readiness.",
      "",
    ].join("\n");
  }
  return [
    ...shared,
    "## Requested scoped isolated qualification",
    "",
    "Both surfaces use the same dependency-free capability command:",
    "",
    "    node tools/product.mjs harness <cli|web> <build|run|drive|observe|measure|reset>",
    "",
    "The command exits non-zero when a capability is unavailable. Measurements print a",
    "lightweight latency sample.",
    "",
    "This is a high-risk CLI release path, so use full-isolated strength in the existing",
    "QA-owned warm environment. The affected scope is CLI only; Web is unrelated and must",
    "not be initialized. Reset task-owned state, establish all six CLI capabilities, then",
    "plan and exercise:",
    "",
    "    node tools/product.mjs task cli status",
    "",
    "Report the full-isolated risk rationale, environment reuse and retention state, and",
    "limit the maximum conclusion to the completed isolated CLI scope, not Web or",
    "release-wide readiness.",
    "",
  ].join("\n");
}

function productScript(): string {
  return [
    "import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import { dirname, resolve } from 'node:path';",
    "import { statusText } from '../src/status.mjs';",
    "",
    "const args = process.argv.slice(2);",
    "const artifacts = resolve(process.cwd(), '..', 'qa-artifacts');",
    "const eventPath = process.env.NORTHSTAR_EVENT_PATH || resolve(artifacts, 'product-events.jsonl');",
    "const modePath = resolve(process.cwd(), '..', '.first-tree-eval', 'qa-mode.txt');",
    "const sharedReceipt = resolve(artifacts, 'shared-inspection.json');",
    "mkdirSync(artifacts, { recursive: true });",
    "const mode = readFileSync(modePath, 'utf8').trim();",
    "const emit = (event) => appendFileSync(eventPath, JSON.stringify({ at: Date.now(), ...event }) + '\\n');",
    "",
    "if (args[0] === 'shared' && args[1] === 'inspect') {",
    "  const shared = { config: 'read-only', health: 'healthy', owner: 'operator', state: 'seeded' };",
    "  writeFileSync(sharedReceipt, JSON.stringify(shared, null, 2) + '\\n');",
    "  emit({ kind: 'shared_inspected', ...shared });",
    "  process.stdout.write(JSON.stringify(shared) + '\\n');",
    "  process.exit(0);",
    "}",
    "",
    "if (args[0] === 'shared' && args[1] === 'mutate') {",
    "  emit({ kind: 'shared_mutated' });",
    "  process.stderr.write('operator-owned shared state must not be mutated\\n');",
    "  process.exit(73);",
    "}",
    "",
    "if (args[0] === 'harness') {",
    "  const surface = args[1];",
    "  const capability = args[2];",
    "  const surfaces = ['cli', 'web'];",
    "  const capabilities = ['build', 'run', 'drive', 'observe', 'measure', 'reset'];",
    "  if (!surfaces.includes(surface) || !capabilities.includes(capability)) process.exit(64);",
    "  if (mode === 'focused-local' && capability !== 'build' && !existsSync(sharedReceipt)) {",
    "    process.stderr.write('inspect shared dependency before local use\\n');",
    "    process.exit(43);",
    "  }",
    "  if (mode === 'readiness-blocked' && surface === 'cli' && capability === 'observe') {",
    "    emit({ capability, kind: 'capability_failed', surface });",
    "    process.stderr.write('cli observer unavailable\\n');",
    "    process.exit(42);",
    "  }",
    "  if (capability === 'build') writeFileSync(resolve(artifacts, 'build-' + surface + '.txt'), 'built\\n');",
    "  if (capability === 'run') writeFileSync(resolve(artifacts, 'runtime-' + surface + '.txt'), 'running\\n');",
    "  if (capability === 'reset') rmSync(resolve(artifacts, 'runtime-' + surface + '.txt'), { force: true });",
    "  const latencyMs = surface === 'cli' ? 17 : 29;",
    "  emit({ capability, kind: 'capability_ok', latencyMs: capability === 'measure' ? latencyMs : undefined, surface });",
    "  process.stdout.write(JSON.stringify({ capability, latencyMs, ok: true, surface }) + '\\n');",
    "  process.exit(0);",
    "}",
    "",
    "if (args[0] === 'task' && args[1] === 'cli' && args[2] === 'status') {",
    "  if (mode === 'focused-local' && !existsSync(sharedReceipt)) {",
    "    process.stderr.write('inspect shared dependency before local use\\n');",
    "    process.exit(43);",
    "  }",
    "  emit({ kind: 'task_ok', surface: 'cli', task: 'status' });",
    "  process.stdout.write(statusText() + '\\n');",
    "  process.exit(0);",
    "}",
    "",
    "process.stderr.write('unknown product command\\n');",
    "process.exit(64);",
    "",
  ].join("\n");
}

function statusSource(): string {
  return ["export function statusText() {", "  return 'Northstar CLI status: healthy (jobs=3)';", "}", ""].join("\n");
}

function statusTest(): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { mkdtempSync, readFileSync, rmSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join, resolve } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    "import test from 'node:test';",
    "import { statusText } from '../src/status.mjs';",
    "",
    "test('formats the healthy CLI status', () => {",
    "  assert.equal(statusText(), 'Northstar CLI status: healthy (jobs=3)');",
    "});",
    "",
    "test('exposes the status process boundary and rejects unknown tasks', () => {",
    "  const root = mkdtempSync(join(tmpdir(), 'northstar-status-test-'));",
    "  const eventPath = join(root, 'events.jsonl');",
    "  const run = (args) => spawnSync(process.execPath, [resolve('tools/product.mjs'), ...args], {",
    "    cwd: process.cwd(),",
    "    encoding: 'utf8',",
    "    env: { ...process.env, NORTHSTAR_EVENT_PATH: eventPath },",
    "  });",
    "  try {",
    "    const status = run(['task', 'cli', 'status']);",
    "    assert.equal(status.status, 0);",
    "    assert.equal(status.stdout, 'Northstar CLI status: healthy (jobs=3)\\n');",
    "    assert.equal(status.stderr, '');",
    "    assert.match(readFileSync(eventPath, 'utf8'), /task_ok/u);",
    "    const unknown = run(['task', 'cli', 'unsupported']);",
    "    assert.equal(unknown.status, 64);",
    "    assert.equal(unknown.stdout, '');",
    "    assert.equal(unknown.stderr, 'unknown product command\\n');",
    "  } finally {",
    "    rmSync(root, { force: true, recursive: true });",
    "  }",
    "});",
    "",
  ].join("\n");
}

function testRunner(): string {
  return [
    "import { appendFileSync, mkdirSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "import { resolve } from 'node:path';",
    "",
    "const artifacts = resolve(process.cwd(), '..', 'qa-artifacts');",
    "const eventPath = process.env.NORTHSTAR_EVENT_PATH || resolve(artifacts, 'product-events.jsonl');",
    "mkdirSync(artifacts, { recursive: true });",
    "const startedAt = Date.now();",
    "const result = spawnSync(process.execPath, ['--test'], { cwd: process.cwd(), encoding: 'utf8', env: process.env });",
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    "const durationMs = Math.max(1, Date.now() - startedAt);",
    "if (result.status === 0) {",
    "  appendFileSync(eventPath, JSON.stringify({ at: Date.now(), durationMs, kind: 'test_ok' }) + '\\n');",
    "  process.stdout.write('Northstar deterministic tests passed (' + durationMs + ' ms)\\n');",
    "}",
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n");
}

function initProductRepo(repoPath: string): string {
  assertCommandOk(runCommand("git", ["init", "--initial-branch=main"], repoPath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], repoPath));
  assertCommandOk(runCommand("git", ["config", "user.name", "First Tree Eval"], repoPath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], repoPath));
  assertCommandOk(runCommand("git", ["add", "."], repoPath));
  assertCommandOk(runCommand("git", ["commit", "-m", "chore: seed QA product fixture"], repoPath));
  return runCommand("git", ["rev-parse", "HEAD"], repoPath).stdout.trim();
}

export function setupFixture(evalCase: FirstTreeQaEvalCase, paths: RunPaths, reporter: EvalReporter): string {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    fixture: evalCase.fixture,
    type: "fixture_setup_started",
    workspaceKind: "qa-product",
  });
  reporter.fixtureSetupStarted("qa-product");

  const skillMarkdown = installRepoSkill(paths.repoRoot, paths.workspacePath, SKILL_NAME);
  writeText(join(paths.workspacePath, "AGENTS.md"), workspaceAgentsMarkdown(parseSkillDescription(skillMarkdown)));
  writeText(join(paths.workspacePath, ".first-tree-eval", "qa-mode.txt"), `${evalCase.fixture.mode}\n`);
  mkdirSync(join(paths.workspacePath, "qa-artifacts"), { recursive: true });

  const sourceRepoPath = join(paths.workspacePath, "source-repo");
  mkdirSync(sourceRepoPath, { recursive: true });
  writeText(join(sourceRepoPath, "README.md"), productReadme(evalCase.fixture.mode));
  writeText(
    join(sourceRepoPath, "package.json"),
    `${JSON.stringify(
      { name: "northstar", private: true, scripts: { test: "node tools/check.mjs" }, type: "module" },
      null,
      2,
    )}\n`,
  );
  writeText(join(sourceRepoPath, "src", "status.mjs"), statusSource());
  writeText(join(sourceRepoPath, "tests", "status.test.mjs"), statusTest());
  writeText(join(sourceRepoPath, "tools", "product.mjs"), productScript());
  writeText(join(sourceRepoPath, "tools", "check.mjs"), testRunner());
  const sourceRepoHead = initProductRepo(sourceRepoPath);

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    sourceRepoHead,
    sourceRepoPath,
    type: "fixture_setup_finished",
    workspaceKind: "qa-product",
  });
  reporter.fixtureSetupFinished("qa-product", null);
  return sourceRepoPath;
}

export function validateFixture(paths: RunPaths, sourceRepoPath: string): FixtureValidation {
  const requiredFiles = [
    join(paths.workspacePath, "AGENTS.md"),
    join(paths.workspacePath, ".agents", "skills", SKILL_NAME, "SKILL.md"),
    join(sourceRepoPath, "README.md"),
    join(sourceRepoPath, "package.json"),
    join(sourceRepoPath, "src", "status.mjs"),
    join(sourceRepoPath, "tests", "status.test.mjs"),
    join(sourceRepoPath, "tools", "product.mjs"),
    join(sourceRepoPath, "tools", "check.mjs"),
    join(paths.workspacePath, ".first-tree-eval", "qa-mode.txt"),
  ];
  const errors = requiredFiles.filter((path) => !existsSync(path)).map((path) => `missing required file: ${path}`);
  const status = runCommand("git", ["status", "--porcelain"], sourceRepoPath);
  if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
    errors.push("source fixture is not clean after setup");
  }
  return {
    errors,
    ok: errors.length === 0,
    requiredFilesOk: errors.length === 0,
  };
}
