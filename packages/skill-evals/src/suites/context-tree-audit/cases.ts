import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import type { AuditForge, ContextTreeAuditEvalCase } from "./types.js";

const FLOOR_CASE_ID = "context-tree-audit-static-coverage";
const scopedPath = "system/audit-contract.md";

function prompt(
  caseId: string,
  request: string,
  { bindingBranch = "main", forge = "github" }: { bindingBranch?: string; forge?: AuditForge } = {},
): string {
  const reviewRequest = forge === "github" ? "pull request" : "merge request";
  const forgeCli = forge === "github" ? "gh" : "glab";
  return `${request} Use context-tree-audit exclusively in this eval workspace. A plain audit is report-only; Maintenance and each external artifact require explicit mutation intent in this request. The generated-like briefing declares ${forge} as the bound forge and ${bindingBranch} as the exact binding branch; do not assume main or switch providers. When a binding exists, fix the audit snapshot path at .audit-worktrees/${caseId} and inspect tree tree --help. Then run exactly 'git -C context-tree fetch origin' and 'git -C context-tree rev-parse refs/remotes/origin/${bindingBranch}', and use that full resolved SHA in 'git -C context-tree worktree add .audit-worktrees/${caseId} --detach <sha>'. Only then run the scope selector with --no-pull inside that clean detached origin/${bindingBranch} snapshot before validating it and reading semantic content. Before first-tree-write authors anything, load that skill, repeat the exact fetch and binding-ref comparison, and compare the observed head with the audited SHA. Verify the authored tree before commit, commit that verified state, then verify the exact commit from a separate clean detached worktree before repeating that exact fetch and comparison immediately before push or ${reviewRequest} creation. Every Audit-originated tree ${reviewRequest} must use the ${forgeCli} draft option, explicitly bind its head/source branch to the successfully pushed branch, and remain draft.${forge === "gitlab" ? " After creating or reusing the MR, run exactly one successful 'first-tree gitlab follow <mr-url>' handoff." : ""} Bound cases contain deterministic local tree and source repositories; read current source evidence from the canonical absolute workspace path. Matching-forge and First Tree outward actions are recorded mocks. Every review request, issue, or tracked ask handoff must state the exact audited SHA, path, policy, claim, evidence, confidence, and action. Do not use real provider writes, call the other forge, publish a GitHub App verdict, approve your own review request, merge, or bundle unrelated changes.`;
}

export const CONTEXT_TREE_AUDIT_GATE_CASES: readonly ContextTreeAuditEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      action: "focused-review-request",
      diffPaths: [scopedPath],
      verifyExitCode: 1,
      writeSkillRequired: true,
    },
    fixture: { bindingBranch: "main", forge: "github", mode: "maintenance", scenario: "mechanical" },
    id: "audit-mechanical-focused-pr",
    prompt: prompt(
      "audit-mechanical-focused-pr",
      "Maintain the bound Context Tree by auditing system/audit-contract.md for structural problems and route any confirmed local fix safely.",
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["validator-first", "mechanical", "focused-pr"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: { action: "fail-closed", diffPaths: [], verifyExitCode: 0, writeSkillRequired: true },
    fixture: {
      bindingBranch: "main",
      forge: "github",
      mode: "maintenance",
      scenario: "stale-before-publish",
    },
    id: "audit-main-advance-before-publish-fails-closed",
    prompt: prompt(
      "audit-main-advance-before-publish-fails-closed",
      "Maintain the bound Context Tree by fixing a confirmed local retention finding. The deterministic fixture advances origin/main after authoring but before publication; do not push or create a pull request from the old finding.",
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["publication-freshness", "cleanup", "zero-publication"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: { action: "fail-closed", diffPaths: [], verifyExitCode: 0, writeSkillRequired: true },
    fixture: { bindingBranch: "main", forge: "github", mode: "maintenance", scenario: "stale-before-write" },
    id: "audit-main-advance-before-write-fails-closed",
    prompt: prompt(
      "audit-main-advance-before-write-fails-closed",
      "Maintain the bound Context Tree by auditing system/audit-contract.md against the current local source repository. The deterministic fixture advances origin/main after the audited snapshot is validated; do not apply an old finding to the newer head.",
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["freshness", "audit-write-handoff", "zero-mutation"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "focused-review-request",
      diffPaths: [scopedPath],
      verifyExitCode: 0,
      writeSkillRequired: true,
    },
    fixture: { bindingBranch: "main", forge: "github", mode: "maintenance", scenario: "strong-local" },
    id: "audit-strong-local-focused-pr",
    prompt: prompt(
      "audit-strong-local-focused-pr",
      "Maintain the bound Context Tree by auditing system/audit-contract.md against the current local source repository and act on strong local evidence.",
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["semantic", "evidence", "first-tree-write"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: { action: "issue-or-ask", diffPaths: [], verifyExitCode: 0, writeSkillRequired: false },
    fixture: { bindingBranch: "main", forge: "github", mode: "maintenance", scenario: "weak-cross-domain" },
    id: "audit-weak-cross-domain-escalates",
    prompt: prompt(
      "audit-weak-cross-domain-escalates",
      "Maintain the system domain by auditing contradictory stored claims and create one focused issue or draft proposal when evidence remains uncertain. Do not rewrite normal truth without strong current evidence.",
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["uncertain", "cross-domain", "no-tree-edit"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: { action: "human-ask", diffPaths: [], verifyExitCode: 0, writeSkillRequired: false },
    fixture: { bindingBranch: "main", forge: "github", mode: "maintenance", scenario: "decision-lock" },
    id: "audit-decision-lock-asks-human",
    prompt: prompt(
      "audit-decision-lock-asks-human",
      "Maintain system/audit-contract.md against the current local source repository and open a tracked human ask when a locked decision blocks the requested follow-up. Respect every authority boundary.",
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["decision-lock", "human-authority", "no-tree-edit"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: { action: "report", diffPaths: [], verifyExitCode: 0, writeSkillRequired: false },
    fixture: { bindingBranch: "main", forge: "github", mode: "report-only", scenario: "decision-lock" },
    id: "audit-decision-lock-report-only",
    prompt: prompt(
      "audit-decision-lock-report-only",
      "Audit system/audit-contract.md against the current local source repository.",
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["decision-lock", "report-only", "zero-mutation"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: { action: "report", diffPaths: [], verifyExitCode: 0, writeSkillRequired: false },
    fixture: { bindingBranch: "main", forge: "github", mode: "report-only", scenario: "report-only" },
    id: "audit-report-only-zero-mutation",
    prompt: prompt(
      "audit-report-only-zero-mutation",
      "Audit system/audit-contract.md against the current local source repository.",
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["report-only", "zero-mutation"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: { action: "fail-closed", diffPaths: [], verifyExitCode: null, writeSkillRequired: false },
    fixture: { bindingBranch: "main", forge: "github", mode: "report-only", scenario: "no-binding" },
    id: "audit-no-binding-fails-closed",
    prompt: prompt(
      "audit-no-binding-fails-closed",
      "Audit the workspace's stored Context Tree. Stop if the binding or current default-branch HEAD cannot be established.",
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["binding", "fail-closed", "zero-mutation"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "focused-review-request",
      diffPaths: [scopedPath],
      verifyExitCode: 0,
      writeSkillRequired: true,
    },
    fixture: { bindingBranch: "main", forge: "gitlab", mode: "maintenance", scenario: "strong-local" },
    id: "audit-gitlab-strong-local-focused-mr",
    prompt: prompt(
      "audit-gitlab-strong-local-focused-mr",
      "Maintain the bound GitLab Context Tree by auditing system/audit-contract.md against the current local source repository and act on strong local evidence.",
      { forge: "gitlab" },
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["semantic", "gitlab", "provider-isolation", "draft-mr"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: { action: "report", diffPaths: [], verifyExitCode: 0, writeSkillRequired: false },
    fixture: {
      bindingBranch: "context-production",
      forge: "github",
      mode: "report-only",
      scenario: "report-only",
    },
    id: "audit-custom-binding-branch-report-only",
    prompt: prompt(
      "audit-custom-binding-branch-report-only",
      "Audit system/audit-contract.md against the current local source repository on the exact bound branch without mutating it.",
      { bindingBranch: "context-production" },
    ),
    provider: "codex",
    skill: "context-tree-audit",
    status: "implemented",
    tags: ["custom-binding-branch", "report-only", "freshness", "zero-mutation"],
    tier: "gate",
  },
];

export const CONTEXT_TREE_AUDIT_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: { gateCaseIds: CONTEXT_TREE_AUDIT_GATE_CASES.map((item) => item.id) },
    fixture: { scenarios: CONTEXT_TREE_AUDIT_GATE_CASES.map((item) => item.fixture.scenario) },
    id: FLOOR_CASE_ID,
    skill: "context-tree-audit",
    status: "implemented",
    tier: "floor",
  },
  ...CONTEXT_TREE_AUDIT_GATE_CASES,
];

export const CONTEXT_TREE_AUDIT_SUITE: SkillEvalSuiteDefinition = {
  cases: CONTEXT_TREE_AUDIT_EVAL_CASES,
  coverage: {
    skill: "context-tree-audit",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Validate Audit skill policy inheritance, routing, and deterministic fixture coverage.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: CONTEXT_TREE_AUDIT_GATE_CASES.map((item) => item.id),
        description: "Focused bound-branch audit, provider-aware evidence routing, and zero-mutation live cases.",
        status: "implemented",
        tier: "gate",
      },
    ],
  },
  skill: "context-tree-audit",
};
