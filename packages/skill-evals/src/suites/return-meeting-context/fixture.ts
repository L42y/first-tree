import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { appendEvent } from "../../core/events.js";
import type { EvalReporter } from "../../core/reporter.js";
import { installRepoSkill, parseSkillDescription } from "../../core/skills/install.js";
import type { RunPaths } from "../../core/types.js";
import type { FixtureValidation, MeetingFixtureMode, ReturnMeetingContextEvalCase } from "./types.js";

const SKILL_NAME = "return-meeting-context";

function workspaceAgentsMarkdown(skillDescription: string): string {
  return `# Meeting Context Eval Workspace

Use the installed skill when its description applies.

## Available Skills

| Skill | Load when |
|---|---|
| \`return-meeting-context\` | ${skillDescription} |

Read \`.agents/skills/return-meeting-context/SKILL.md\` before acting.

The user-supplied source boundary is exactly \`source-artifacts/bundle.json\`
and the files it references. Do not discover or follow any other source. Write
only the sanitized packet \`meeting-context-output.json\` at workspace root.
Run the installed validator. Do not call external providers, create a Context
Tree, invoke first-tree-write, send messages, or create PRs in this eval.
`;
}

function artifact(
  artifactId: string,
  sourceRole: "human_minutes" | "ai_notes" | "transcript",
  chronologyIndex: number,
  completeness: "complete" | "partial",
): Record<string, unknown> {
  return {
    artifact_id: artifactId,
    input_kind: "attachment",
    media_type: "text/markdown",
    source_role: sourceRole,
    revision: `synthetic-${artifactId}-v1`,
    completeness,
    chronology_index: chronologyIndex,
    content_ref: { kind: "task_file", locator: `source-artifacts/${artifactId}.md` },
    extraction_warnings: completeness === "complete" ? [] : ["The exported final page is missing."],
  };
}

function bundleFor(mode: MeetingFixtureMode): Record<string, unknown> {
  const requestedIntent = mode === "later-override" ? "write" : "analyze";
  if (mode === "later-override") {
    return {
      schema: "return-meeting-context.artifact-bundle.v1",
      meeting_scope: "single-meeting",
      requested_intent: requestedIntent,
      artifacts: [
        artifact("proposal", "transcript", 0, "complete"),
        artifact("final-minutes", "human_minutes", 1, "complete"),
      ],
    };
  }
  if (mode === "ai-notes") {
    return {
      schema: "return-meeting-context.artifact-bundle.v1",
      meeting_scope: "single-meeting",
      requested_intent: requestedIntent,
      artifacts: [artifact("ai-notes", "ai_notes", 0, "complete")],
    };
  }
  if (mode === "partial-source") {
    return {
      schema: "return-meeting-context.artifact-bundle.v1",
      meeting_scope: "single-meeting",
      requested_intent: requestedIntent,
      artifacts: [
        artifact("minutes", "human_minutes", 0, "complete"),
        artifact("appendix", "transcript", 1, "partial"),
      ],
    };
  }
  return {
    schema: "return-meeting-context.artifact-bundle.v1",
    meeting_scope: "single-meeting",
    requested_intent: requestedIntent,
    artifacts: [artifact("minutes", "human_minutes", 0, "complete")],
  };
}

function sourceFiles(mode: MeetingFixtureMode): Record<string, string> {
  if (mode === "later-override") {
    return {
      "proposal.md": `# Earlier discussion

Option A proposes calendar-owned ingestion for every visible meeting.
This is a proposal, not a final decision.
`,
      "final-minutes.md": `# Human-confirmed minutes

## Decision

Replace option A. Meeting context return starts from artifacts the user
explicitly supplies and remains provider-agnostic.

## Rationale

An explicit artifact boundary works for provider documents, uploads, local
files, and pasted text without hidden discovery.

## Constraint

Raw meeting material remains outside persistent output and the Context Tree.
`,
    };
  }
  if (mode === "ai-notes") {
    return {
      "ai-notes.md": `# AI-generated notes

The summary says the team decided to build an automatic meeting index for
every provider. No human-confirmed decision section or approval is present.
`,
    };
  }
  if (mode === "partial-source") {
    return {
      "minutes.md": "# Minutes\n\nA durable source policy may have been discussed.\n",
      "appendix.md": "# Partial export\n\nThe final page is unavailable.\n",
    };
  }
  return {
    "minutes.md": `# Weekly meeting

- Status: migration work is halfway complete.
- Task owner will prepare a demo.
- Ship date is next Friday.
- Temporary blocker: staging capacity.

No durable policy or architecture decision was made.
`,
  };
}

function initSourceRepo(sourceRepoPath: string): string {
  assertCommandOk(runCommand("git", ["init", "--initial-branch=main"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "user.name", "First Tree Eval"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["add", "."], sourceRepoPath));
  assertCommandOk(runCommand("git", ["commit", "-m", "test: seed meeting artifact fixture"], sourceRepoPath));
  return runCommand("git", ["rev-parse", "HEAD"], sourceRepoPath).stdout.trim();
}

export function setupFixture(evalCase: ReturnMeetingContextEvalCase, paths: RunPaths, reporter: EvalReporter): string {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    fixture: evalCase.fixture,
    type: "fixture_setup_started",
    workspaceKind: "meeting-artifacts",
  });
  reporter.fixtureSetupStarted("meeting-artifacts");

  const skillMarkdown = installRepoSkill(paths.repoRoot, paths.workspacePath, SKILL_NAME);
  writeText(join(paths.workspacePath, "AGENTS.md"), workspaceAgentsMarkdown(parseSkillDescription(skillMarkdown)));

  const sourceRepoPath = join(paths.workspacePath, "source-artifacts");
  mkdirSync(sourceRepoPath, { recursive: true });
  writeText(join(sourceRepoPath, "bundle.json"), `${JSON.stringify(bundleFor(evalCase.fixture.mode), null, 2)}\n`);
  for (const [name, content] of Object.entries(sourceFiles(evalCase.fixture.mode))) {
    writeText(join(sourceRepoPath, name), content);
  }
  const sourceRepoHead = initSourceRepo(sourceRepoPath);

  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    sourceRepoHead,
    sourceRepoPath,
    type: "fixture_setup_finished",
    workspaceKind: "meeting-artifacts",
  });
  reporter.fixtureSetupFinished("meeting-artifacts", null);
  return sourceRepoPath;
}

export function validateFixture(paths: RunPaths, sourceRepoPath: string): FixtureValidation {
  const required = [
    join(paths.workspacePath, "AGENTS.md"),
    join(paths.workspacePath, ".agents", "skills", SKILL_NAME, "SKILL.md"),
    join(paths.workspacePath, ".agents", "skills", SKILL_NAME, "scripts", "validate-output.mjs"),
    join(sourceRepoPath, "bundle.json"),
  ];
  const errors = required.filter((path) => !existsSync(path)).map((path) => `missing required file: ${path}`);
  const status = runCommand("git", ["status", "--porcelain"], sourceRepoPath);
  if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
    errors.push("source artifact fixture is not clean after setup");
  }
  return {
    errors,
    ok: errors.length === 0,
    requiredFilesOk: errors.length === 0,
  };
}
