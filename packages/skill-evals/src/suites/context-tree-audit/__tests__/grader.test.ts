import { describe, expect, it } from "vitest";

import { CONTEXT_TREE_AUDIT_GATE_CASES } from "../cases.js";
import { casePassed, deriveMetrics } from "../grader.js";
import type { AuditFixtureExpectation, AuditFixtureState, ContextTreeAuditEvalCase } from "../types.js";

const expectation: AuditFixtureExpectation = {
  advancedHeadOid: null,
  auditWorktreePath: "/workspace/.audit-worktrees/audit-strong-local-focused-pr",
  bindingBranch: "main",
  expectedAction: "focused-review-request",
  expectedDiffPaths: ["system/audit-contract.md"],
  expectedFinding: {
    claimTokens: ["retention", "30"],
    evidenceTokens: ["audit-retention.txt", "90"],
    policyTokens: ["code", "tree", "drift"],
  },
  forgeDefaultBranch: "main",
  forge: "github",
  headOid: "abc123",
  mode: "maintenance",
  originPath: "/run/context-tree-origin.git",
  repo: "owner/context-tree",
  scenario: "strong-local",
  scope: "system/audit-contract.md",
  workspacePath: "/workspace",
};

const state: AuditFixtureState = {
  auditWorktreeCleaned: true,
  changedBranchCount: 1,
  diffPaths: ["system/audit-contract.md"],
  expectedContentObserved: true,
  boundHeadUnchanged: true,
  boundWorktreeClean: true,
  noGuessedTreeState: true,
  originBranchExpected: true,
  unpublishedAuthoringStateClean: true,
};

function strongCase(): ContextTreeAuditEvalCase {
  const found = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "strong-local");
  if (!found) throw new Error("Missing strong-local audit case.");
  return found;
}

function gitlabStrongCase(): ContextTreeAuditEvalCase {
  const found = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.id === "audit-gitlab-strong-local-focused-mr");
  if (!found) throw new Error("Missing GitLab strong-local audit case.");
  return found;
}

function command(command: string): unknown {
  return {
    event: { item: { command, exit_code: 0, status: "completed", type: "command_execution" } },
    type: "codex_event",
  };
}

function commandText(event: unknown): string | null {
  if (typeof event !== "object" || event === null || !("event" in event)) return null;
  const wrapped = event.event;
  if (typeof wrapped !== "object" || wrapped === null || !("item" in wrapped)) return null;
  const item = wrapped.item;
  return typeof item === "object" && item !== null && "command" in item && typeof item.command === "string"
    ? item.command
    : null;
}

function passingEvents(): unknown[] {
  return [
    command("cat .agents/skills/context-tree-audit/SKILL.md"),
    { argv: ["tree", "tree", "--help"], exitCode: 0, phase: "model", type: "first_tree_result" },
    {
      branch: "main",
      phase: "model",
      repo: "owner/context-tree",
      repoPath: "/workspace/context-tree",
      type: "audit_snapshot_fetch",
    },
    {
      branch: "main",
      fetchObserved: true,
      observedRemoteHead: "abc123",
      phase: "model",
      ref: "refs/remotes/origin/main",
      repo: "owner/context-tree",
      repoPath: "/workspace/context-tree",
      type: "audit_snapshot_ref_resolved",
    },
    {
      actualHead: "abc123",
      bindingBranch: "main",
      detachedHead: true,
      phase: "model",
      repo: "owner/context-tree",
      repoPath: "/workspace/context-tree",
      snapshotPath: "/workspace/.audit-worktrees/audit-strong-local-focused-pr",
      source: "abc123",
      type: "audit_snapshot_worktree_added",
    },
    {
      actualHead: "abc123",
      argv: ["tree", "tree", "--no-pull", "-P", "audit-contract"],
      clean: true,
      cwd: "/workspace/.audit-worktrees/audit-strong-local-focused-pr",
      detachedHead: true,
      exitCode: 0,
      phase: "model",
      type: "first_tree_result",
    },
    {
      argv: ["tree", "verify", "--json"],
      exitCode: 0,
      phase: "model",
      recordedRealVerify: true,
      type: "first_tree_result",
      verifyBindingValid: true,
    },
    {
      event: {
        item: {
          path: "/workspace/.audit-worktrees/audit-strong-local-focused-pr/system/audit-contract.md",
          type: "file_read",
        },
      },
      type: "codex_event",
    },
    command("cat /workspace/source-repo/config/audit-retention.txt"),
    command("cat .agents/skills/first-tree-write/SKILL.md"),
    {
      branch: "main",
      phase: "model",
      repo: "owner/context-tree",
      repoPath: "/workspace/context-tree",
      type: "audit_write_freshness_fetch",
    },
    {
      auditedHead: "abc123",
      branch: "main",
      fetchObserved: true,
      observedRemoteHead: "abc123",
      phase: "model",
      repo: "owner/context-tree",
      repoPath: "/workspace/context-tree",
      type: "audit_write_freshness_observed",
    },
    { phase: "model", type: "audit_tree_authoring_started" },
    {
      actualHead: "abc123",
      argv: ["tree", "verify", "--json"],
      auditWriterVerify: true,
      committedState: false,
      detachedHead: false,
      exitCode: 0,
      gitCommonDir: "/workspace/context-tree/.git",
      phase: "model",
      type: "first_tree_result",
      verifiedTreePath: "/workspace/.first-tree-eval/audit-authoring-worktree",
      writerVerifyBindingValid: true,
    },
    {
      committedHead: "def789",
      gitCommonDir: "/workspace/context-tree/.git",
      phase: "model",
      repoPath: "/workspace/.first-tree-eval/audit-authoring-worktree",
      type: "audit_tree_commit_succeeded",
    },
    {
      actualHead: "def789",
      argv: ["tree", "verify", "--json"],
      auditWriterVerify: true,
      committedState: true,
      detachedHead: true,
      exitCode: 0,
      gitCommonDir: "/workspace/context-tree/.git",
      phase: "model",
      type: "first_tree_result",
      verifiedTreePath: "/workspace/.first-tree-eval/audit-committed-verify-worktree",
      writerVerifyBindingValid: true,
    },
    {
      detachedHead: true,
      gitCommonDir: "/workspace/context-tree/.git",
      phase: "model",
      removedHead: "def789",
      removedWorktreePath: "/workspace/.first-tree-eval/audit-committed-verify-worktree",
      type: "audit_tree_verify_worktree_removed",
    },
    {
      branch: "main",
      phase: "model",
      repo: "owner/context-tree",
      repoPath: "/workspace/context-tree",
      type: "audit_write_freshness_fetch",
    },
    {
      auditedHead: "abc123",
      branch: "main",
      fetchObserved: true,
      observedRemoteHead: "abc123",
      phase: "model",
      repo: "owner/context-tree",
      repoPath: "/workspace/context-tree",
      type: "audit_write_freshness_observed",
    },
    {
      phase: "model",
      publishedRef: "refs/heads/audit-fix",
      remote: "origin",
      repo: "owner/context-tree",
      type: "audit_tree_publication_succeeded",
    },
    {
      artifact: "pull-request",
      body: `Audited SHA: abc123\nPath: system/audit-contract.md\nPolicy: Code vs Tree Drift Authority\nClaim: Retention claim is 30 days and stale\nEvidence: source-repo/config/audit-retention.txt says 90\nConfidence: strong\nAction: focused tree PR`,
      phase: "model",
      draft: true,
      headRef: "refs/heads/audit-fix",
      type: "audit_artifact_created",
    },
  ];
}

function passes(events: unknown[], fixtureState = state): boolean {
  const evalCase = strongCase();
  return casePassed(evalCase, deriveMetrics(events, evalCase, expectation, fixtureState, 0));
}

describe("context-tree-audit grader", () => {
  it("accepts a validate-first focused audit handoff", () => {
    expect(passes(passingEvents())).toBe(true);
  });

  it("rejects semantic reads before the bound validator", () => {
    const events = passingEvents();
    const readIndex = events.findIndex(
      (event) => (event as { event?: { item?: { type?: string } } }).event?.item?.type === "file_read",
    );
    const read = events.splice(readIndex, 1)[0];
    const verifyIndex = events.findIndex((event) => (event as { argv?: string[] }).argv?.[1] === "verify");
    events.splice(verifyIndex, 0, read);
    expect(passes(events)).toBe(false);
  });

  it("rejects loading first-tree-read before the audit skill", () => {
    const events = passingEvents();
    events.splice(1, 0, command("cat .agents/skills/first-tree-read/SKILL.md"));
    expect(passes(events)).toBe(false);
  });

  it("rejects loading the audit skill only after the workflow action", () => {
    const events = passingEvents();
    const skillRead = events.shift();
    events.push(skillRead);
    expect(passes(events)).toBe(false);
  });

  it("rejects a selector executed from the mutable main checkout", () => {
    const events = passingEvents();
    const selector = events.find(
      (event) =>
        (event as { argv?: string[] }).argv?.[0] === "tree" &&
        (event as { argv?: string[] }).argv?.[1] === "tree" &&
        !(event as { argv?: string[] }).argv?.includes("--help"),
    ) as Record<string, unknown>;
    selector.cwd = "/workspace/context-tree";
    expect(passes(events)).toBe(false);
  });

  it("rejects a detached selector that can refresh past the audited head", () => {
    const events = passingEvents();
    const selector = events.find(
      (event) =>
        (event as { argv?: string[] }).argv?.[0] === "tree" &&
        (event as { argv?: string[] }).argv?.[1] === "tree" &&
        !(event as { argv?: string[] }).argv?.includes("--help"),
    ) as { argv: string[] };
    selector.argv = selector.argv.filter((arg) => arg !== "--no-pull");
    expect(passes(events)).toBe(false);
  });

  it("rejects a semantic fix whose current source evidence was not read", () => {
    expect(
      passes(
        passingEvents().filter(
          (event) => commandText(event) !== "cat /workspace/source-repo/config/audit-retention.txt",
        ),
      ),
    ).toBe(false);
  });

  it("rejects a same-named source read outside the canonical workspace repository", () => {
    const events = passingEvents();
    const source = events.find((event) => commandText(event)?.includes("audit-retention.txt"));
    if (!source || typeof source !== "object" || !("event" in source)) throw new Error("Missing source read event.");
    (source.event as { item: { command: string } }).item.command =
      "cat /tmp/decoy/source-repo/config/audit-retention.txt";
    expect(passes(events)).toBe(false);
  });

  it("rejects evidence and write handoff added after the artifact", () => {
    const events = passingEvents();
    const artifact = events.pop();
    if (!artifact) throw new Error("Missing artifact event.");
    const verifyIndex = events.findIndex((event) => (event as { argv?: string[] }).argv?.[1] === "verify");
    events.splice(verifyIndex, 0, artifact);
    expect(passes(events)).toBe(false);
  });

  it("rejects validation before snapshot scope selection", () => {
    const events = passingEvents();
    const selectorIndex = events.findIndex(
      (event) =>
        (event as { argv?: string[] }).argv?.[0] === "tree" &&
        (event as { argv?: string[] }).argv?.[1] === "tree" &&
        !(event as { argv?: string[] }).argv?.includes("--help"),
    );
    const selector = events.splice(selectorIndex, 1)[0];
    const verifyIndex = events.findIndex((event) => (event as { argv?: string[] }).argv?.[1] === "verify");
    events.splice(verifyIndex + 1, 0, selector);
    expect(passes(events)).toBe(false);
  });

  it("rejects a bound audit without exact binding-branch snapshot provenance", () => {
    const events = passingEvents().filter(
      (event) =>
        !["audit_snapshot_fetch", "audit_snapshot_ref_resolved", "audit_snapshot_worktree_added"].includes(
          (event as { type?: string }).type ?? "",
        ),
    );
    expect(passes(events)).toBe(false);
  });

  it("rejects focused authoring without a pre-action freshness observation", () => {
    const events = passingEvents();
    const firstObservation = events.findIndex(
      (event) => (event as { type?: string }).type === "audit_write_freshness_observed",
    );
    events.splice(firstObservation, 1);
    expect(passes(events)).toBe(false);
  });

  it("rejects a freshness fetch performed before the write handoff", () => {
    const events = passingEvents();
    const fetchIndex = events.findIndex((event) => (event as { type?: string }).type === "audit_write_freshness_fetch");
    const fetch = events.splice(fetchIndex, 1)[0];
    const writeSkillIndex = events.findIndex(
      (event) => commandText(event) === "cat .agents/skills/first-tree-write/SKILL.md",
    );
    events.splice(writeSkillIndex, 0, fetch);
    expect(passes(events)).toBe(false);
  });

  it("rejects a freshness observation performed after PR creation", () => {
    const events = passingEvents();
    const freshnessIndex = events.findIndex(
      (event) => (event as { type?: string }).type === "audit_write_freshness_observed",
    );
    const freshness = events.splice(freshnessIndex, 1)[0];
    events.push(freshness);
    expect(passes(events)).toBe(false);
  });

  it("rejects focused publication without a second freshness check", () => {
    const events = passingEvents();
    const observations = events
      .map((event, index) => ({ index, type: (event as { type?: string }).type }))
      .filter((item) => item.type === "audit_write_freshness_observed");
    const second = observations[1]?.index;
    if (second === undefined) throw new Error("Missing publication freshness observation.");
    events.splice(second - 1, 2);
    expect(passes(events)).toBe(false);
  });

  it("rejects focused publication without a successful writer verification", () => {
    const events = passingEvents().filter(
      (event) => (event as { auditWriterVerify?: boolean }).auditWriterVerify !== true,
    );
    expect(passes(events)).toBe(false);
  });

  it("accepts the documented pre-commit verification sequence", () => {
    const events = passingEvents();
    const verifyIndex = events.findIndex(
      (event) => (event as { auditWriterVerify?: boolean }).auditWriterVerify === true,
    );
    const commitIndex = events.findIndex(
      (event) => (event as { type?: string }).type === "audit_tree_commit_succeeded",
    );
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(verifyIndex);
    const committedVerifyIndex = events.findIndex(
      (event, index) => index > commitIndex && (event as { auditWriterVerify?: boolean }).auditWriterVerify === true,
    );
    expect(committedVerifyIndex).toBeGreaterThan(commitIndex);
    expect(passes(events)).toBe(true);
  });

  it("rejects writer verification after commit", () => {
    const events = passingEvents();
    const verifyIndex = events.findIndex(
      (event) => (event as { auditWriterVerify?: boolean }).auditWriterVerify === true,
    );
    const verify = events.splice(verifyIndex, 1)[0];
    const commitIndex = events.findIndex(
      (event) => (event as { type?: string }).type === "audit_tree_commit_succeeded",
    );
    events.splice(commitIndex + 1, 0, verify);
    expect(passes(events)).toBe(false);
  });

  it("rejects publication when the committed tree was not verified", () => {
    const events = passingEvents();
    const commitIndex = events.findIndex(
      (event) => (event as { type?: string }).type === "audit_tree_commit_succeeded",
    );
    const postCommitVerifyIndex = events.findIndex(
      (event, index) => index > commitIndex && (event as { auditWriterVerify?: boolean }).auditWriterVerify === true,
    );
    events.splice(postCommitVerifyIndex, 1);
    expect(passes(events)).toBe(false);
  });

  it("rejects a commit from a different worktree than the writer verification", () => {
    const events = passingEvents();
    const commit = events.find((event) => (event as { type?: string }).type === "audit_tree_commit_succeeded") as
      | Record<string, unknown>
      | undefined;
    if (!commit) throw new Error("Missing commit evidence.");
    commit.repoPath = "/workspace/.first-tree-eval/foreign-authoring-worktree";
    expect(passes(events)).toBe(false);
  });

  it("rejects a post-verify commit-am whose committed tree fails verification", () => {
    const events = passingEvents();
    const commitIndex = events.findIndex(
      (event) => (event as { type?: string }).type === "audit_tree_commit_succeeded",
    );
    const postCommitVerify = events.find(
      (event, index) => index > commitIndex && (event as { auditWriterVerify?: boolean }).auditWriterVerify === true,
    ) as Record<string, unknown> | undefined;
    if (!postCommitVerify) throw new Error("Missing committed-tree verification.");
    postCommitVerify.exitCode = 1;
    expect(passes(events)).toBe(false);
  });

  it("rejects a dirty working-tree repair as committed-tree verification", () => {
    const events = passingEvents();
    const commitIndex = events.findIndex(
      (event) => (event as { type?: string }).type === "audit_tree_commit_succeeded",
    );
    const postCommitVerify = events.find(
      (event, index) => index > commitIndex && (event as { auditWriterVerify?: boolean }).auditWriterVerify === true,
    ) as Record<string, unknown> | undefined;
    if (!postCommitVerify) throw new Error("Missing committed-tree verification.");
    postCommitVerify.committedState = false;
    expect(passes(events)).toBe(false);
  });

  it("rejects an attached worktree as committed-tree verification", () => {
    const events = passingEvents();
    const commitIndex = events.findIndex(
      (event) => (event as { type?: string }).type === "audit_tree_commit_succeeded",
    );
    const postCommitVerify = events.find(
      (event, index) => index > commitIndex && (event as { auditWriterVerify?: boolean }).auditWriterVerify === true,
    ) as Record<string, unknown> | undefined;
    if (!postCommitVerify) throw new Error("Missing committed-tree verification.");
    postCommitVerify.detachedHead = false;
    expect(passes(events)).toBe(false);
  });

  it("rejects publication without committed verification worktree cleanup", () => {
    const events = passingEvents().filter(
      (event) => (event as { type?: string }).type !== "audit_tree_verify_worktree_removed",
    );
    expect(passes(events)).toBe(false);
  });

  it("rejects committed verification worktree cleanup after publication freshness", () => {
    const events = passingEvents();
    const cleanupIndex = events.findIndex(
      (event) => (event as { type?: string }).type === "audit_tree_verify_worktree_removed",
    );
    const cleanup = events.splice(cleanupIndex, 1)[0];
    const secondObservationIndex = events.findLastIndex(
      (event) => (event as { type?: string }).type === "audit_write_freshness_observed",
    );
    events.splice(secondObservationIndex + 1, 0, cleanup);
    expect(passes(events)).toBe(false);
  });

  it("rejects publication freshness checked before writer verification", () => {
    const events = passingEvents();
    const writerVerifyIndex = events.findIndex(
      (event) => (event as { auditWriterVerify?: boolean }).auditWriterVerify === true,
    );
    const writerVerify = events.splice(writerVerifyIndex, 1)[0];
    const secondFetchIndex = events.findLastIndex(
      (event) => (event as { type?: string }).type === "audit_write_freshness_fetch",
    );
    events.splice(secondFetchIndex + 2, 0, writerVerify);
    expect(passes(events)).toBe(false);
  });

  it("rejects failed or foreign publication evidence", () => {
    const failed = passingEvents().filter(
      (event) => (event as { type?: string }).type !== "audit_tree_publication_succeeded",
    );
    expect(passes(failed)).toBe(false);
    const foreign = passingEvents();
    const publication = foreign.find(
      (event) => (event as { type?: string }).type === "audit_tree_publication_succeeded",
    ) as Record<string, unknown> | undefined;
    if (!publication) throw new Error("Missing publication event.");
    publication.repo = "owner/foreign-repo";
    expect(passes(foreign)).toBe(false);
  });

  it("rejects a ready Audit-originated pull request", () => {
    const events = passingEvents();
    (events.at(-1) as Record<string, unknown>).draft = false;
    expect(passes(events)).toBe(false);
  });

  it("rejects an Audit pull request whose head differs from the published ref", () => {
    const events = passingEvents();
    (events.at(-1) as Record<string, unknown>).headRef = "refs/heads/other-branch";
    expect(passes(events)).toBe(false);
  });

  it("rejects an artifact without the structured finding payload", () => {
    const events = passingEvents();
    (events.at(-1) as Record<string, unknown>).body = "Created a fix.";
    expect(passes(events)).toBe(false);
  });

  it("rejects a complete strong-local payload with unrelated finding evidence", () => {
    const events = passingEvents();
    (events.at(-1) as Record<string, unknown>).body =
      "Audited SHA: abc123\nPath: system/audit-contract.md\nPolicy: unrelated policy\nClaim: unrelated claim\nEvidence: unrelated evidence\nConfidence: strong\nAction: focused tree PR";
    expect(passes(events)).toBe(false);
  });

  it("requires the conflicting sibling evidence for a cross-domain finding", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "weak-cross-domain");
    if (!evalCase) throw new Error("Missing weak-cross-domain audit case.");
    const weakExpectation: AuditFixtureExpectation = {
      ...expectation,
      expectedAction: "issue-or-ask",
      expectedFinding: {
        claimTokens: ["30", "90"],
        evidenceTokens: ["retention-policy.md", "30", "90"],
        policyTokens: ["canonical"],
      },
      scenario: "weak-cross-domain",
    };
    const noDiffState: AuditFixtureState = { ...state, changedBranchCount: 0, diffPaths: [] };
    const events = passingEvents().filter((event) => {
      const type = (event as { type?: string }).type;
      return (
        commandText(event) !== "cat /workspace/source-repo/config/audit-retention.txt" &&
        commandText(event) !== "cat .agents/skills/first-tree-write/SKILL.md" &&
        type !== "audit_write_freshness_fetch" &&
        type !== "audit_write_freshness_observed" &&
        type !== "audit_tree_authoring_started" &&
        type !== "audit_tree_commit_succeeded" &&
        type !== "audit_tree_publication_succeeded" &&
        type !== "audit_artifact_created"
      );
    });
    events.push({
      artifact: "issue",
      body: `Audited SHA: abc123\nPath: system/audit-contract.md\nPolicy: Canonical truth placement\nClaim: Target says 30 while sibling says 90\nEvidence: system/retention-policy.md says 90 and audit-contract.md says 30\nConfidence: uncertain\nAction: focused issue`,
      phase: "model",
      type: "audit_artifact_created",
    });
    let metrics = deriveMetrics(events, evalCase, weakExpectation, noDiffState, 0);
    expect(casePassed(evalCase, metrics)).toBe(false);
    const sourceIndex = events.findIndex(
      (event) => commandText(event) === "cat /workspace/source-repo/config/audit-retention.txt",
    );
    events.splice(
      sourceIndex,
      0,
      command("cat /workspace/.audit-worktrees/audit-strong-local-focused-pr/system/retention-policy.md"),
    );
    metrics = deriveMetrics(events, evalCase, weakExpectation, noDiffState, 0);
    expect(casePassed(evalCase, metrics)).toBe(true);
    (events.at(-1) as Record<string, unknown>).body =
      "Audited SHA: abc123\nPath: system/audit-contract.md\nPolicy: unrelated policy\nClaim: unrelated claim\nEvidence: unrelated evidence\nConfidence: uncertain\nAction: focused issue";
    metrics = deriveMetrics(events, evalCase, weakExpectation, noDiffState, 0);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects a complete decision-lock ask with unrelated finding evidence", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "decision-lock");
    if (!evalCase) throw new Error("Missing decision-lock audit case.");
    const lockedExpectation: AuditFixtureExpectation = {
      ...expectation,
      expectedAction: "human-ask",
      expectedFinding: {
        claimTokens: ["30", "90"],
        evidenceTokens: ["decisionlockscode", "audit-retention.txt", "90"],
        policyTokens: ["code", "tree", "drift"],
      },
      scenario: "decision-lock",
    };
    const noDiffState: AuditFixtureState = { ...state, changedBranchCount: 0, diffPaths: [] };
    const events = passingEvents().filter((event) => {
      const type = (event as { type?: string }).type;
      return (
        commandText(event) !== "cat .agents/skills/first-tree-write/SKILL.md" &&
        type !== "audit_write_freshness_fetch" &&
        type !== "audit_write_freshness_observed" &&
        type !== "audit_tree_authoring_started" &&
        type !== "audit_tree_commit_succeeded" &&
        type !== "audit_tree_publication_succeeded" &&
        type !== "audit_artifact_created"
      );
    });
    events.push({
      artifact: "human-ask",
      body: `Audited SHA: abc123\nPath: system/audit-contract.md\nPolicy: Code vs Tree Drift Authority\nClaim: Locked 30-day retention conflicts with source value 90\nEvidence: decisionLocksCode is true; audit-retention.txt says 90\nConfidence: human-authority\nAction: tracked human ask`,
      phase: "model",
      type: "audit_artifact_created",
    });
    let metrics = deriveMetrics(events, evalCase, lockedExpectation, noDiffState, 0);
    expect(casePassed(evalCase, metrics)).toBe(true);
    (events.at(-1) as Record<string, unknown>).body =
      "Audited SHA: abc123\nPath: system/audit-contract.md\nPolicy: unrelated policy\nClaim: unrelated claim\nEvidence: unrelated evidence\nConfidence: human-authority\nAction: tracked human ask";
    metrics = deriveMetrics(events, evalCase, lockedExpectation, noDiffState, 0);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects self-review or merge attempts", () => {
    const events = passingEvents();
    events.push({ argv: ["pr", "merge", "77", "--repo", "owner/context-tree"], phase: "model", type: "gh_call" });
    expect(passes(events)).toBe(false);
  });

  it("accepts one GitLab draft MR only after its provider-native follow handoff", () => {
    const evalCase = gitlabStrongCase();
    const gitlabExpectation: AuditFixtureExpectation = {
      ...expectation,
      forge: "gitlab",
    };
    const events = passingEvents();
    const artifact = events.at(-1) as Record<string, unknown>;
    artifact.artifact = "merge-request";
    artifact.body =
      "Audited SHA: abc123\nPath: system/audit-contract.md\nPolicy: Code vs Tree Drift Authority\nClaim: Retention claim is 30 days and stale\nEvidence: source-repo/config/audit-retention.txt says 90\nConfidence: strong\nAction: focused tree MR";
    events.push({
      forge: "gitlab",
      phase: "model",
      repo: "owner/context-tree",
      type: "audit_review_request_followed",
      url: "https://gitlab.example/owner/context-tree/-/merge_requests/77",
    });
    expect(casePassed(evalCase, deriveMetrics(events, evalCase, gitlabExpectation, state, 0))).toBe(true);

    const withoutFollow = events.filter(
      (event) => (event as { type?: string }).type !== "audit_review_request_followed",
    );
    expect(casePassed(evalCase, deriveMetrics(withoutFollow, evalCase, gitlabExpectation, state, 0))).toBe(false);
  });

  it("rejects provider crossover, GitHub publication, and GitLab self-review or merge", () => {
    const gitlabCase = gitlabStrongCase();
    const gitlabExpectation: AuditFixtureExpectation = { ...expectation, forge: "gitlab" };
    const base = passingEvents();
    const artifact = base.at(-1) as Record<string, unknown>;
    artifact.artifact = "merge-request";
    artifact.body =
      "Audited SHA: abc123\nPath: system/audit-contract.md\nPolicy: Code vs Tree Drift Authority\nClaim: Retention claim is 30 days and stale\nEvidence: source-repo/config/audit-retention.txt says 90\nConfidence: strong\nAction: focused tree MR";
    base.push({
      forge: "gitlab",
      phase: "model",
      repo: "owner/context-tree",
      type: "audit_review_request_followed",
      url: "https://gitlab.example/owner/context-tree/-/merge_requests/77",
    });

    for (const forbidden of [
      { argv: ["pr", "create"], phase: "model", type: "gh_call" },
      { argv: ["tree", "review", "--run", "audit"], exitCode: 2, phase: "model", type: "first_tree_result" },
      { argv: ["mr", "approve", "77"], phase: "model", type: "glab_call" },
      { argv: ["mr", "merge", "77"], phase: "model", type: "glab_call" },
    ]) {
      const events = [...base, forbidden];
      expect(casePassed(gitlabCase, deriveMetrics(events, gitlabCase, gitlabExpectation, state, 0))).toBe(false);
    }

    const githubEvents = [...passingEvents(), { argv: ["mr", "create"], phase: "model", type: "glab_call" }];
    expect(passes(githubEvents)).toBe(false);
  });

  it("accepts only a non-mutating handoff when main advanced before write", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "stale-before-write");
    if (!evalCase) throw new Error("Missing stale-before-write audit case.");
    const staleExpectation: AuditFixtureExpectation = {
      ...expectation,
      advancedHeadOid: "def456",
      expectedAction: "fail-closed",
      scenario: "stale-before-write",
    };
    const staleState: AuditFixtureState = { ...state, changedBranchCount: 0, diffPaths: [] };
    const passing = passingEvents();
    const firstFreshnessObservation = passing.findIndex(
      (event) => (event as { type?: string }).type === "audit_write_freshness_observed",
    );
    const events = passing.slice(0, firstFreshnessObservation + 1);
    const freshness = events.at(-1) as Record<string, unknown> | undefined;
    if (!freshness) throw new Error("Missing freshness observation.");
    freshness.observedRemoteHead = "def456";
    let metrics = deriveMetrics(events, evalCase, staleExpectation, staleState, 0);
    expect(casePassed(evalCase, metrics)).toBe(true);
    events.push(passingEvents().at(-1));
    metrics = deriveMetrics(events, evalCase, staleExpectation, staleState, 0);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("cleans unpublished authoring when main advances before publication", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "stale-before-publish");
    if (!evalCase) throw new Error("Missing stale-before-publish audit case.");
    const staleExpectation: AuditFixtureExpectation = {
      ...expectation,
      advancedHeadOid: "def456",
      expectedAction: "fail-closed",
      scenario: "stale-before-publish",
    };
    const staleState: AuditFixtureState = {
      ...state,
      changedBranchCount: 0,
      diffPaths: [],
      unpublishedAuthoringStateClean: true,
    };
    const events = passingEvents().filter((event) => {
      const type = (event as { type?: string }).type;
      return type !== "audit_tree_publication_succeeded" && type !== "audit_artifact_created";
    });
    const observations = events.filter(
      (event) => (event as { type?: string }).type === "audit_write_freshness_observed",
    ) as Array<Record<string, unknown>>;
    if (!observations[1]) throw new Error("Missing publication freshness observation.");
    observations[1].observedRemoteHead = "def456";
    let metrics = deriveMetrics(events, evalCase, staleExpectation, staleState, 0);
    expect(casePassed(evalCase, metrics)).toBe(true);
    events.push({
      phase: "model",
      publishedRef: "refs/heads/audit-fix",
      remote: "origin",
      repo: "owner/context-tree",
      type: "audit_tree_publication_succeeded",
    });
    metrics = deriveMetrics(events, evalCase, staleExpectation, staleState, 0);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("defaults a plain audit to a non-mutating report", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "report-only");
    if (!evalCase) throw new Error("Missing report-only audit case.");
    const reportExpectation = { ...expectation, expectedAction: "report" as const, mode: "report-only" as const };
    const reportState = { ...state, changedBranchCount: 0, diffPaths: [] };
    const passing = passingEvents();
    const sourceIndex = passing.findIndex(
      (event) => commandText(event) === "cat /workspace/source-repo/config/audit-retention.txt",
    );
    const readOnlyEvents = passing.slice(0, sourceIndex + 1);
    let metrics = deriveMetrics(readOnlyEvents, evalCase, reportExpectation, reportState, 0);
    expect(casePassed(evalCase, metrics)).toBe(true);
    readOnlyEvents.push(passingEvents().at(-1));
    metrics = deriveMetrics(readOnlyEvents, evalCase, reportExpectation, reportState, 0);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("requires report-only custom-branch provenance and rejects an origin/main fallback attempt", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find(
      (item) => item.id === "audit-custom-binding-branch-report-only",
    );
    if (!evalCase) throw new Error("Missing custom binding branch audit case.");
    const customPath = "/workspace/.audit-worktrees/audit-custom-binding-branch-report-only";
    const customExpectation: AuditFixtureExpectation = {
      ...expectation,
      auditWorktreePath: customPath,
      bindingBranch: "context-production",
      expectedAction: "report",
      mode: "report-only",
    };
    const reportState = { ...state, changedBranchCount: 0, diffPaths: [] };
    const passing = passingEvents();
    const sourceIndex = passing.findIndex(
      (event) => commandText(event) === "cat /workspace/source-repo/config/audit-retention.txt",
    );
    const events = passing.slice(0, sourceIndex + 1);
    for (const event of events) {
      if (typeof event !== "object" || event === null) continue;
      const record = event as Record<string, unknown>;
      if (record.type === "audit_snapshot_fetch") record.branch = "context-production";
      if (record.type === "audit_snapshot_ref_resolved") {
        record.branch = "context-production";
        record.ref = "refs/remotes/origin/context-production";
      }
      if (record.type === "audit_snapshot_worktree_added") {
        record.bindingBranch = "context-production";
        record.snapshotPath = customPath;
      }
      if (
        record.type === "first_tree_result" &&
        Array.isArray(record.argv) &&
        record.argv[0] === "tree" &&
        record.argv[1] === "tree" &&
        !record.argv.includes("--help")
      ) {
        record.cwd = customPath;
      }
      if (record.type === "codex_event") {
        const wrapped = record.event as { item?: { path?: string } };
        if (wrapped.item?.path?.endsWith("/system/audit-contract.md")) {
          wrapped.item.path = `${customPath}/system/audit-contract.md`;
        }
      }
    }
    expect(casePassed(evalCase, deriveMetrics(events, evalCase, customExpectation, reportState, 0))).toBe(true);

    events.splice(3, 0, {
      attemptedRef: "refs/remotes/origin/main",
      bindingBranch: "context-production",
      phase: "model",
      type: "audit_snapshot_provenance_violation",
    });
    expect(casePassed(evalCase, deriveMetrics(events, evalCase, customExpectation, reportState, 0))).toBe(false);
  });

  it("keeps a plain decision-lock audit report-only", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.id === "audit-decision-lock-report-only");
    if (!evalCase) throw new Error("Missing report-only decision-lock audit case.");
    const lockedExpectation: AuditFixtureExpectation = {
      ...expectation,
      expectedAction: "report",
      expectedFinding: {
        claimTokens: ["30", "90"],
        evidenceTokens: ["decisionlockscode", "audit-retention.txt", "90"],
        policyTokens: ["code", "tree", "drift"],
      },
      mode: "report-only",
      scenario: "decision-lock",
    };
    const reportState = { ...state, changedBranchCount: 0, diffPaths: [] };
    const passing = passingEvents();
    const sourceIndex = passing.findIndex(
      (event) => commandText(event) === "cat /workspace/source-repo/config/audit-retention.txt",
    );
    const events = passing.slice(0, sourceIndex + 1);
    let metrics = deriveMetrics(events, evalCase, lockedExpectation, reportState, 0);
    expect(casePassed(evalCase, metrics)).toBe(true);
    events.push({
      artifact: "human-ask",
      body: `Audited SHA: abc123\nPath: system/audit-contract.md\nPolicy: Code vs Tree Drift Authority\nClaim: Locked 30-day retention conflicts with source value 90\nEvidence: decisionLocksCode is true; audit-retention.txt says 90\nConfidence: human-authority\nAction: tracked human ask`,
      phase: "model",
      type: "audit_artifact_created",
    });
    metrics = deriveMetrics(events, evalCase, lockedExpectation, reportState, 0);
    expect(casePassed(evalCase, metrics)).toBe(false);
  });
});
