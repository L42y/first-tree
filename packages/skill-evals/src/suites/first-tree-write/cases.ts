import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import { FIRST_TREE_WRITE_QUALITY_CASE } from "./quality.js";
import type { FirstTreeWriteEvalCase } from "./types.js";

const FLOOR_CASE_ID = "first-tree-write-static-coverage";

export const FIRST_TREE_WRITE_GATE_CASES: readonly FirstTreeWriteEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      action: "refuse_without_source",
      requireVerify: false,
      responseHints: ["source", "artifact", "provide"],
      treeDiff: "none",
    },
    fixture: {
      sourceArtifact: "absent",
      treeState: "populated",
    },
    forbidden: {
      content: ["## Source", "Shipped in", "PR #", "function ", "interface ", "## Owners"],
      sideEffects: ["tree_write", "tree_pr"],
    },
    id: "no-source-refuses",
    prompt:
      "Use first-tree-write to update the Context Tree with the latest architecture decision. No source artifact is available in this workspace.",
    provider: "codex",
    skill: "first-tree-write",
    status: "implemented",
    tags: ["source-boundary"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "write_minimal_tree_diff",
      requiredDiffSnippets: ["deterministic", "quality", "judge"],
      requireVerify: true,
      responseHints: ["updated", "verify"],
      treeDiff: "minimal",
    },
    fixture: {
      sourceArtifact: "durable-decision-note",
      treeState: "populated",
    },
    forbidden: {
      content: ["## Source", "Shipped in", "PR #", "function ", "interface ", "GET /", "## Owners"],
      sideEffects: ["source_write"],
    },
    id: "durable-source-writes",
    prompt: "Use first-tree-write to reflect `source-artifacts/durable-decision-note.md` into the Context Tree.",
    provider: "codex",
    skill: "first-tree-write",
    status: "implemented",
    tags: ["tree-diff", "verify"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "refuse_implementation_only_source",
      requireVerify: false,
      responseHints: ["implementation", "detail", "not belong", "does not belong", "durable"],
      treeDiff: "none",
    },
    fixture: {
      sourceArtifact: "implementation-only-diff",
      treeState: "populated",
    },
    forbidden: {
      content: ["## Source", "Shipped in", "PR #", "function create", "interface Eval", "GET /"],
      sideEffects: ["tree_write", "tree_pr"],
    },
    id: "implementation-only-no-write",
    prompt:
      "Use first-tree-write to evaluate whether `source-artifacts/implementation-only-diff.md` belongs in the Context Tree.",
    provider: "codex",
    skill: "first-tree-write",
    status: "implemented",
    tags: ["source-boundary"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "skip_tree_write_unbound",
      requireVerify: false,
      responseHints: ["deterministic", "quality", "judge"],
      treeDiff: "none",
    },
    fixture: {
      sourceArtifact: "durable-decision-note",
      treeState: "unbound",
    },
    forbidden: {
      content: [],
      sideEffects: ["tree_write", "tree_pr"],
    },
    id: "unbound-tree-skips-write",
    prompt: "Summarize `source-artifacts/durable-decision-note.md` in three bullets.",
    provider: "codex",
    skill: "first-tree-write",
    status: "implemented",
    tags: ["unbound-tree"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "report_unbound_tree_write_gap",
      requireVerify: false,
      responseHints: ["no tree is bound", "no bound tree", "cannot be completed"],
      treeDiff: "none",
    },
    fixture: {
      sourceArtifact: "durable-decision-note",
      treeState: "unbound",
    },
    forbidden: {
      content: [],
      sideEffects: ["tree_write", "tree_pr"],
    },
    id: "unbound-tree-explicit-write-reports-gap",
    prompt: "Use first-tree-write to reflect `source-artifacts/durable-decision-note.md` into the Context Tree.",
    provider: "codex",
    skill: "first-tree-write",
    status: "implemented",
    tags: ["unbound-tree", "source-boundary"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "skip_tree_write_unresolved",
      requireVerify: false,
      responseHints: ["deterministic", "quality", "judge"],
      treeDiff: "none",
    },
    fixture: {
      sourceArtifact: "durable-decision-note",
      treeState: "unresolved",
    },
    forbidden: {
      content: [],
      sideEffects: ["tree_write", "tree_pr"],
    },
    id: "unresolved-tree-skips-write",
    prompt: "Summarize `source-artifacts/durable-decision-note.md` in three bullets.",
    provider: "codex",
    skill: "first-tree-write",
    status: "implemented",
    tags: ["unbound-tree", "unresolved-tree"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "report_unresolved_tree_write_gap",
      requireVerify: false,
      responseHints: ["binding could not be confirmed", "could not confirm", "cannot be completed"],
      treeDiff: "none",
    },
    fixture: {
      sourceArtifact: "durable-decision-note",
      treeState: "unresolved",
    },
    forbidden: {
      content: [],
      sideEffects: ["tree_write", "tree_pr"],
    },
    id: "unresolved-tree-explicit-write-reports-gap",
    prompt: "Use first-tree-write to reflect `source-artifacts/durable-decision-note.md` into the Context Tree.",
    provider: "codex",
    skill: "first-tree-write",
    status: "implemented",
    tags: ["unbound-tree", "unresolved-tree", "source-boundary"],
    tier: "gate",
  },
];

export const FIRST_TREE_WRITE_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      gateCaseIds: FIRST_TREE_WRITE_GATE_CASES.map((evalCase) => evalCase.id),
      validator: "case schema and fixture shape",
    },
    fixture: {
      sourceArtifacts: ["absent", "durable-decision-note", "implementation-only-diff"],
      treeStates: ["populated", "unbound", "unresolved"],
    },
    id: FLOOR_CASE_ID,
    skill: "first-tree-write",
    status: "implemented",
    tier: "floor",
  },
  ...FIRST_TREE_WRITE_GATE_CASES,
  FIRST_TREE_WRITE_QUALITY_CASE,
];

function validateFirstTreeWriteFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  for (const evalCase of cases.filter((candidate) => candidate.skill === "first-tree-write")) {
    if (typeof evalCase.fixture !== "object" || evalCase.fixture === null || Array.isArray(evalCase.fixture)) {
      errors.push(`${evalCase.id}: fixture must be an object.`);
      continue;
    }
    const fixture = evalCase.fixture as { sourceArtifact?: unknown; treeState?: unknown };
    if (evalCase.tier === "gate" && typeof fixture.sourceArtifact !== "string") {
      errors.push(`${evalCase.id}: gate fixture must declare sourceArtifact.`);
    }
    if (evalCase.tier === "gate" && typeof fixture.treeState !== "string") {
      errors.push(`${evalCase.id}: gate fixture must declare treeState.`);
    }
  }
  return errors;
}

export const FIRST_TREE_WRITE_SUITE: SkillEvalSuiteDefinition = {
  cases: FIRST_TREE_WRITE_EVAL_CASES,
  coverage: {
    skill: "first-tree-write",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Validate write suite case schema and source/tree fixture shape.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: FIRST_TREE_WRITE_GATE_CASES.map((evalCase) => evalCase.id),
        description: "Implemented source-boundary, tree-diff, unbound, and unresolved-binding live gate cases.",
        status: "implemented",
        tier: "gate",
      },
      {
        caseIds: [FIRST_TREE_WRITE_QUALITY_CASE.id],
        description: "LLM-as-judge node quality case for durable, source-bounded tree writing.",
        status: "implemented",
        tier: "quality",
      },
    ],
  },
  skill: "first-tree-write",
  validateFloor: validateFirstTreeWriteFloor,
};
