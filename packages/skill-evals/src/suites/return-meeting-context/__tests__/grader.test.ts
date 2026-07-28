import { describe, expect, it } from "vitest";

import { RETURN_MEETING_CONTEXT_GATE_CASES } from "../cases.js";
import { buildGrading, casePassed } from "../grader.js";
import type { EvalMetrics, FixtureValidation } from "../types.js";

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
    skillFileReadObserved: true,
    sourceRepoChanged: false,
    statusObserved: true,
    validatorResult: {
      args: [],
      command: "node",
      cwd: "/tmp/return-meeting-context-eval",
      exitCode: 0,
      stderr: "",
      stdout: "{}",
    },
    validatorSucceeded: true,
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
});
