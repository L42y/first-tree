import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { assertCommandOk, runCommand, writeText } from "../../core/commands.js";
import { appendEvent } from "../../core/events.js";
import type { EvalReporter } from "../../core/reporter.js";
import { parseSkillDescription } from "../../core/skills/install.js";
import type { RunPaths } from "../../core/types.js";
import type { FixtureValidation, MeetingFixtureMode, MeetingRecordsEvalCase } from "./types.js";

export const SKILL_NAME = "synthesize-meeting-records";
export const OUTPUT_NAME = "meeting-analysis-output.json";

function installStandaloneSkill(repoRoot: string, workspacePath: string): string {
  const sourceDir = join(repoRoot, "skills", ".experimental", SKILL_NAME);
  const skillPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`Missing standalone skill: ${sourceDir}`);

  const agentsDir = join(workspacePath, ".agents", "skills", SKILL_NAME);
  const claudeDir = join(workspacePath, ".claude", "skills");
  const claudeLink = join(claudeDir, SKILL_NAME);
  rmSync(agentsDir, { force: true, recursive: true });
  mkdirSync(dirname(agentsDir), { recursive: true });
  cpSync(sourceDir, agentsDir, { recursive: true });
  rmSync(claudeLink, { force: true, recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  symlinkSync(join("..", "..", ".agents", "skills", SKILL_NAME), claudeLink, "dir");
  return readFileSync(skillPath, "utf8");
}

function agentsMarkdown(description: string): string {
  return `# Standalone Meeting Skill Eval

Use installed skills only when their descriptions apply to the user's natural
request.

## Available Skills

| Skill | Load when |
|---|---|
| \`${SKILL_NAME}\` | ${description} |

When the skill applies, read
\`.agents/skills/${SKILL_NAME}/SKILL.md\` before acting.

The user-supplied source boundary is exactly \`source-artifacts/bundle.json\`
and the files it references. Do not discover or follow any other source. The
only permitted workspace write is the sanitized packet \`${OUTPUT_NAME}\`.
Do not call external providers or downstream publication systems. Do not copy
verbatim source prose into the packet or final response.
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
    extraction_warnings: completeness === "complete" ? [] : ["The final page is unavailable."],
  };
}

function bundleFor(mode: MeetingFixtureMode): Record<string, unknown> {
  if (mode === "later-override") {
    return {
      schema: "synthesize-meeting-records.artifact-bundle.v1",
      meeting_scope: "single-meeting",
      artifacts: [
        artifact("proposal", "transcript", 0, "complete"),
        artifact("final-minutes", "human_minutes", 1, "complete"),
      ],
    };
  }
  if (mode === "ai-only") {
    return {
      schema: "synthesize-meeting-records.artifact-bundle.v1",
      meeting_scope: "single-meeting",
      artifacts: [artifact("ai-notes", "ai_notes", 0, "complete")],
    };
  }
  if (mode === "partial-source") {
    return {
      schema: "synthesize-meeting-records.artifact-bundle.v1",
      meeting_scope: "single-meeting",
      artifacts: [
        artifact("minutes", "human_minutes", 0, "complete"),
        artifact("appendix", "transcript", 1, "partial"),
      ],
    };
  }
  return {
    schema: "synthesize-meeting-records.artifact-bundle.v1",
    meeting_scope: "single-meeting",
    artifacts: [artifact("minutes", "human_minutes", 0, "complete")],
  };
}

function sourceFiles(mode: MeetingFixtureMode): Record<string, string> {
  if (mode === "later-override") {
    return {
      "proposal.md": `# Earlier discussion

Option Alpha would make provider-specific capture the default.
VERBATIM-CANARY-ALPHA-271828
This is a proposal, not a final choice.
`,
      "final-minutes.md": `# Human-confirmed minutes

Replace the earlier proposal. The final choice is Option Beta: accept only
records the user explicitly supplies, independent of provider.
VERBATIM-CANARY-BETA-161803
`,
    };
  }
  if (mode === "ai-only") {
    return {
      "ai-notes.md": `# AI-generated notes

The summary says the team chose a meeting index, assigned a prototype, and
identified privacy exposure as a risk. No human confirmation is present.
VERBATIM-CANARY-AI-141421
`,
    };
  }
  if (mode === "partial-source") {
    return {};
  }
  return {
    "minutes.md": `# Human-confirmed minutes

VERBATIM-CANARY-SIX-314159

- Decision: adopt normalized ingestion labels.
- Progress: the parser now handles four input forms.
- Plan: pilot the workflow next sprint.
- Action: the delivery lead will prepare a sample bundle.
- Blocker: provider export coverage remains incomplete.
- Risk: OCR may omit table structure.
`,
  };
}

function initSourceRepo(sourceRepoPath: string): string {
  assertCommandOk(runCommand("git", ["init", "--initial-branch=main"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "user.email", "eval@example.invalid"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "user.name", "Standalone Skill Eval"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["config", "commit.gpgsign", "false"], sourceRepoPath));
  assertCommandOk(runCommand("git", ["add", "."], sourceRepoPath));
  assertCommandOk(runCommand("git", ["commit", "-m", "test: seed meeting record fixture"], sourceRepoPath));
  return runCommand("git", ["rev-parse", "HEAD"], sourceRepoPath).stdout.trim();
}

export function setupFixture(evalCase: MeetingRecordsEvalCase, paths: RunPaths, reporter: EvalReporter): string {
  appendEvent(paths.eventsPath, {
    caseId: evalCase.id,
    fixture: evalCase.fixture,
    type: "fixture_setup_started",
    workspaceKind: "standalone-meeting-records",
  });
  reporter.fixtureSetupStarted("standalone-meeting-records");

  const skillMarkdown = installStandaloneSkill(paths.repoRoot, paths.workspacePath);
  writeText(join(paths.workspacePath, "AGENTS.md"), agentsMarkdown(parseSkillDescription(skillMarkdown)));

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
    workspaceKind: "standalone-meeting-records",
  });
  reporter.fixtureSetupFinished("standalone-meeting-records", null);
  return sourceRepoPath;
}

export function validateFixture(paths: RunPaths, sourceRepoPath: string): FixtureValidation {
  const required = [
    join(paths.workspacePath, "AGENTS.md"),
    join(paths.workspacePath, ".agents", "skills", SKILL_NAME, "SKILL.md"),
    join(paths.workspacePath, ".agents", "skills", SKILL_NAME, "scripts", "validate-output.mjs"),
    join(sourceRepoPath, "bundle.json"),
  ];
  const missingFiles = required.filter((path) => !existsSync(path));
  const errors = missingFiles.map((path) => `missing required file: ${path}`);
  const bundle = JSON.parse(readFileSync(join(sourceRepoPath, "bundle.json"), "utf8")) as {
    artifacts?: Array<{ completeness?: unknown; content_ref?: { locator?: unknown } }>;
  };
  if (bundle.artifacts?.some((artifact) => artifact.completeness !== "complete")) {
    for (const artifact of bundle.artifacts) {
      const locator = artifact.content_ref?.locator;
      if (typeof locator === "string" && existsSync(join(paths.workspacePath, locator))) {
        errors.push(`partial-source fixture exposed raw artifact: ${locator}`);
      }
    }
  }
  const status = runCommand("git", ["status", "--porcelain"], sourceRepoPath);
  if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
    errors.push("source artifact fixture is not clean after setup");
  }
  return {
    errors,
    ok: errors.length === 0,
    requiredFilesOk: missingFiles.length === 0,
  };
}
