import { describe, expect, it } from "vitest";

import { SYNTHESIZE_MEETING_RECORDS_CASES } from "../cases.js";
import { casePassed, evaluatePacket, rawArtifactReadObserved } from "../grader.js";
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
    rawArtifactReadObserved: false,
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

  it("detects raw artifact reads from the model command trace", () => {
    const currentCase = evalCase("partial-source");
    expect(rawArtifactReadObserved([commandEvent("sed -n '1,80p' source-artifacts/appendix.md")], currentCase)).toBe(
      true,
    );
    expect(rawArtifactReadObserved([commandEvent("sed -n '1,80p' source-artifacts/bundle.json")], currentCase)).toBe(
      false,
    );
  });

  it("fails partial-source runs that read raw content before blocking", () => {
    const currentCase = evalCase("partial-source");
    expect(
      casePassed(
        currentCase,
        { errors: [], ok: true, requiredFilesOk: true },
        passingMetrics({
          rawArtifactReadObserved: true,
        }),
      ),
    ).toBe(false);
  });

  it("allows complete-source runs to read the supplied record while keeping raw prose out of output", () => {
    const currentCase = evalCase("six-categories");
    expect(
      casePassed(
        currentCase,
        { errors: [], ok: true, requiredFilesOk: true },
        passingMetrics({
          rawArtifactReadObserved: true,
        }),
      ),
    ).toBe(true);
  });

  it("fails when the skill is not read or a raw canary leaks", () => {
    const currentCase = evalCase("six-categories");
    expect(
      casePassed(
        currentCase,
        { errors: [], ok: true, requiredFilesOk: true },
        passingMetrics({
          skillFileReadObserved: false,
        }),
      ),
    ).toBe(false);
    expect(
      casePassed(
        currentCase,
        { errors: [], ok: true, requiredFilesOk: true },
        passingMetrics({
          rawCanaries: ["verbatim-canary-six-314159"],
        }),
      ),
    ).toBe(false);
  });
});
