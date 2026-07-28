import { describe, expect, it } from "vitest";

import { RETURN_MEETING_CONTEXT_GATE_CASES } from "../cases.js";
import { buildGrading, casePassed, deriveRoutingObservation } from "../grader.js";
import type { EvalMetrics, FixtureValidation, ReturnMeetingContextEvalCase } from "../types.js";

const fixtureValidation: FixtureValidation = {
  errors: [],
  ok: true,
  requiredFilesOk: true,
};

function passingMetrics(): EvalMetrics {
  return {
    candidateCountObserved: true,
    chronologyObserved: true,
    contextTreeCreated: false,
    finalResponse: "Analysis complete.",
    forbiddenClaimTerms: [],
    handoffObserved: true,
    packetExists: true,
    packetText: "{}",
    requiredClaimTermsObserved: true,
    runnerExitCode: 0,
    settlementObserved: true,
    interpreterSkillReadOrder: 0,
    routingOrderObserved: true,
    skillFileReadObserved: true,
    sourceRepoChanged: false,
    statusObserved: true,
    validatorInvocationOrder: 1,
    validatorResult: {
      args: [],
      command: "node",
      cwd: "/tmp/return-meeting-context-eval",
      exitCode: 0,
      stderr: "",
      stdout: "{}",
    },
    validatorSucceeded: true,
    writerSkillReadOrder: null,
  };
}

function composedRoutingCase(): ReturnMeetingContextEvalCase {
  const evalCase = RETURN_MEETING_CONTEXT_GATE_CASES.find(
    (candidate) => candidate.fixture.routing === "meeting-vs-write",
  );
  if (evalCase === undefined) throw new Error("missing composed routing eval case");
  return evalCase;
}

function command(commandText: string): unknown {
  return {
    event: {
      item: {
        command: commandText,
        exit_code: 0,
        status: "completed",
        type: "command_execution",
      },
    },
    type: "codex_event",
  };
}

describe("return-meeting-context grader", () => {
  it("passes only when routing, validation, semantic outcome, and safety all pass", () => {
    const evalCase = RETURN_MEETING_CONTEXT_GATE_CASES[0];
    if (evalCase === undefined) throw new Error("missing eval case");
    const metrics = passingMetrics();
    expect(casePassed(fixtureValidation, metrics)).toBe(true);
    expect(buildGrading(evalCase, fixtureValidation, metrics).passed).toBe(true);
  });

  it("fails when the source changes or an overridden claim survives", () => {
    const evalCase = RETURN_MEETING_CONTEXT_GATE_CASES[1];
    if (evalCase === undefined) throw new Error("missing eval case");
    const metrics = {
      ...passingMetrics(),
      forbiddenClaimTerms: ["option a"],
      sourceRepoChanged: true,
    };
    expect(casePassed(fixtureValidation, metrics)).toBe(false);
    expect(buildGrading(evalCase, fixtureValidation, metrics).riskFlags).toHaveLength(2);
  });

  it("fails the composed route when first-tree-write is read before the meeting interpreter", () => {
    const evalCase = composedRoutingCase();
    const routing = deriveRoutingObservation(
      [
        command("cat .agents/skills/first-tree-write/SKILL.md"),
        command("cat .agents/skills/return-meeting-context/SKILL.md"),
        command("node .agents/skills/return-meeting-context/scripts/validate-output.mjs"),
      ],
      evalCase,
    );

    expect(routing).toEqual({
      interpreterSkillReadOrder: 1,
      routingOrderObserved: false,
      validatorInvocationOrder: 2,
      writerSkillReadOrder: 0,
    });
    expect(casePassed(fixtureValidation, { ...passingMetrics(), ...routing })).toBe(false);
  });

  it("fails the composed route when packet validation happens after first-tree-write", () => {
    const evalCase = composedRoutingCase();
    const routing = deriveRoutingObservation(
      [
        command("cat .agents/skills/return-meeting-context/SKILL.md"),
        command("cat .agents/skills/first-tree-write/SKILL.md"),
        command("node .agents/skills/return-meeting-context/scripts/validate-output.mjs"),
      ],
      evalCase,
    );

    expect(routing).toEqual({
      interpreterSkillReadOrder: 0,
      routingOrderObserved: false,
      validatorInvocationOrder: 2,
      writerSkillReadOrder: 1,
    });
    expect(casePassed(fixtureValidation, { ...passingMetrics(), ...routing })).toBe(false);
  });

  it("passes the composed route when interpreter and validation precede first-tree-write", () => {
    const evalCase = composedRoutingCase();
    const routing = deriveRoutingObservation(
      [
        command("cat .agents/skills/return-meeting-context/SKILL.md"),
        command("node .agents/skills/return-meeting-context/scripts/validate-output.mjs"),
        command("cat .agents/skills/first-tree-write/SKILL.md"),
      ],
      evalCase,
    );

    expect(routing).toEqual({
      interpreterSkillReadOrder: 0,
      routingOrderObserved: true,
      validatorInvocationOrder: 1,
      writerSkillReadOrder: 2,
    });
    expect(casePassed(fixtureValidation, { ...passingMetrics(), ...routing })).toBe(true);
  });
});
