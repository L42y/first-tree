import { describe, expect, it } from "vitest";

import { SYNTHESIZE_MEETING_RECORDS_CASES } from "../cases.js";
import { assistantVisibleText, casePassed, evaluatePacket, skillFileReadObserved } from "../grader.js";
import type { EvalMetrics, MeetingRecordsEvalCase } from "../types.js";

function evalCase(mode: MeetingRecordsEvalCase["fixture"]["mode"]): MeetingRecordsEvalCase {
  const found = SYNTHESIZE_MEETING_RECORDS_CASES.find((candidate) => candidate.fixture.mode === mode);
  if (found === undefined) throw new Error(`Missing ${mode} eval case.`);
  return found;
}

function item(category: string, statement: string, settlement: "confirmed" | "uncertain" = "confirmed") {
  return {
    category,
    statement,
    context: `${statement} with supporting context`,
    settlement: {
      basis: settlement === "confirmed" ? "human_confirmed_minutes" : "ai_generated_summary",
      status: settlement,
    },
    chronology: {
      later_override_checked: true,
      overridden_items_excluded: true,
    },
    evidence: [{ artifact_id: "minutes", location_hint: "Relevant section" }],
  };
}

function sixCategoryPacket() {
  return {
    schema: "synthesize-meeting-records.meeting-analysis-packet.v1",
    source_revision: "a".repeat(64),
    status: "complete",
    reason: "Six confirmed findings.",
    items: [
      item("decision", "Adopt normalized ingestion labels"),
      item("progress", "Parser handles four input forms"),
      item("plan", "Pilot the workflow next sprint"),
      item("action", "Delivery lead prepares a sample bundle"),
      item("blocker", "Provider export coverage remains incomplete"),
      item("risk", "OCR may omit table structure"),
    ],
  };
}

function commandEvent(command: string) {
  return {
    type: "codex_event",
    event: {
      item: {
        command,
        exit_code: 0,
        status: "completed",
        type: "command_execution",
      },
    },
  };
}

function nativeReadEvent(path: string) {
  return {
    type: "codex_event",
    event: {
      item: {
        type: "file_read",
        path,
      },
    },
  };
}

function assistantEvent(text: string) {
  return {
    type: "codex_event",
    event: {
      type: "assistant_message",
      text,
    },
  };
}

function claudeToolUseEvent(id: string, name: "Bash" | "Read", input: Record<string, unknown>) {
  return {
    type: "codex_event",
    event: {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name, input }],
      },
    },
  };
}

function claudeToolResultEvent(id: string, isError = false) {
  return {
    type: "codex_event",
    event: {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "done" }],
      },
    },
  };
}

function claudeAssistantEvent(text: string) {
  return {
    type: "codex_event",
    event: {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
  };
}

function passingMetrics(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    categoriesObserved: true,
    chronologyObserved: true,
    contextTreeCreated: false,
    finalResponse: "Synthesis complete.",
    forbiddenTerms: [],
    itemCountObserved: true,
    packetExists: true,
    packetText: "{}",
    rawCanaries: [],
    requiredTermsObserved: true,
    runnerExitCode: 0,
    settlementObserved: true,
    skillFileReadObserved: true,
    sourceRepoChanged: false,
    statusObserved: true,
    validatorResult: {
      args: [],
      command: "node",
      cwd: "/tmp/eval",
      exitCode: 0,
      stderr: "",
      stdout: "",
    },
    validatorSucceeded: true,
    ...overrides,
  };
}

describe("standalone synthesize-meeting-records grader", () => {
  it("requires all six categories without raw prose leakage", () => {
    const currentCase = evalCase("six-categories");
    expect(evaluatePacket(sixCategoryPacket(), currentCase, JSON.stringify(sixCategoryPacket()), "")).toMatchObject({
      categoriesObserved: true,
      chronologyObserved: true,
      itemCountObserved: true,
      rawCanaries: [],
      requiredTermsObserved: true,
      settlementObserved: true,
      statusObserved: true,
    });
  });

  it("rejects a superseded earlier option and raw canary", () => {
    const currentCase = evalCase("later-override");
    const packet = {
      ...sixCategoryPacket(),
      items: [item("decision", "Keep Option Alpha and Option Beta")],
    };
    const evaluation = evaluatePacket(packet, currentCase, JSON.stringify(packet), "");
    expect(evaluation.forbiddenTerms).toContain("option alpha");
    expect(evaluation.categoriesObserved).toBe(true);
    expect(evaluation.requiredTermsObserved).toBe(true);
  });

  it("credits only actual Skill content reads", () => {
    const skillPath = ".agents/skills/synthesize-meeting-records/SKILL.md";
    expect(skillFileReadObserved([commandEvent(`test -f ${skillPath}`)])).toBe(false);
    expect(skillFileReadObserved([commandEvent(`echo ${skillPath}`)])).toBe(false);
    expect(skillFileReadObserved([commandEvent(`rg --files ${skillPath}`)])).toBe(false);
    expect(
      skillFileReadObserved([
        {
          type: "codex_event",
          event: { type: "tool_call", name: "search", arguments: { query: skillPath } },
        },
      ]),
    ).toBe(false);
    expect(skillFileReadObserved([commandEvent(`sed -n '1,220p' ${skillPath}`)])).toBe(true);
    expect(skillFileReadObserved([nativeReadEvent(skillPath)])).toBe(true);
    expect(
      skillFileReadObserved([
        claudeToolUseEvent("skill-read", "Read", { file_path: skillPath }),
        claudeToolResultEvent("skill-read"),
      ]),
    ).toBe(true);
    expect(
      skillFileReadObserved([
        claudeToolUseEvent("skill-bash", "Bash", { command: `sed -n '1,220p' ${skillPath}` }),
        claudeToolResultEvent("skill-bash"),
      ]),
    ).toBe(true);
    expect(skillFileReadObserved([claudeToolUseEvent("failed-read", "Read", { file_path: skillPath })])).toBe(false);
  });

  it("scans intermediate assistant-visible messages but excludes command output", () => {
    const currentCase = evalCase("six-categories");
    const events = [
      assistantEvent("Intermediate VERBATIM-CANARY-SIX-314159 leak."),
      commandEvent("printf VERBATIM-CANARY-SIX-314159"),
      claudeAssistantEvent("Claude also exposed VERBATIM-CANARY-SIX-314159."),
      assistantEvent("Clean final response."),
    ];
    const visibleText = assistantVisibleText(events);
    expect(visibleText).toContain("VERBATIM-CANARY-SIX-314159");
    expect(visibleText).not.toContain("printf");
    expect(
      evaluatePacket(sixCategoryPacket(), currentCase, JSON.stringify(sixCategoryPacket()), visibleText).rawCanaries,
    ).toContain("verbatim-canary-six-314159");
  });

  it("fails when the skill is not read or a raw canary leaks", () => {
    expect(
      casePassed(
        { errors: [], ok: true, requiredFilesOk: true },
        passingMetrics({
          skillFileReadObserved: false,
        }),
      ),
    ).toBe(false);
    expect(
      casePassed(
        { errors: [], ok: true, requiredFilesOk: true },
        passingMetrics({
          rawCanaries: ["verbatim-canary-six-314159"],
        }),
      ),
    ).toBe(false);
  });
});
