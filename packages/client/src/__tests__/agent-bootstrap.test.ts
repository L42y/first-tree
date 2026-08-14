import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => ({
  bootstrapWorkspace: vi.fn(),
  deepEqualIdentity: vi.fn(() => true),
  writeAgentBriefing: vi.fn(),
}));
const migrationMocks = vi.hoisted(() => ({ applyPendingMigrations: vi.fn() }));
const manifestMocks = vi.hoisted(() => ({
  CONTEXT_TREE_DIRNAME: "context-tree",
  LOCAL_CONTEXT_DIRNAME: "local-context",
  ensureWorkspaceManifest: vi.fn(),
  workspaceHasRemoteLatch: vi.fn(() => false),
}));

vi.mock("../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  IDENTITY_JSON_REL: ".first-tree-workspace/identity.json",
  bootstrapWorkspace: bootstrapMocks.bootstrapWorkspace,
  deepEqualIdentity: bootstrapMocks.deepEqualIdentity,
  writeAgentBriefing: bootstrapMocks.writeAgentBriefing,
}));
vi.mock("../runtime/workspace-migrations.js", () => migrationMocks);
vi.mock("../runtime/workspace-manifest.js", () => manifestMocks);

import { ensureAgentBootstrap } from "../runtime/agent-bootstrap.js";
import type { SessionContext } from "../runtime/handler.js";
import { INIT_COMPLETE_SENTINEL_REL } from "../runtime/workspace.js";

function fakeSessionCtx(): SessionContext {
  return {
    agent: {
      agentId: "agent-1",
      inboxId: "inbox-1",
      displayName: "Agent One",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "https://hub.test" },
    log: vi.fn(),
  } as unknown as SessionContext;
}

describe("ensureAgentBootstrap", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ft-agent-bootstrap-"));
    vi.clearAllMocks();
    bootstrapMocks.deepEqualIdentity.mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("keeps the sentinel fast path focused on identity and briefing state", () => {
    const sentinel = join(workspace, INIT_COMPLETE_SENTINEL_REL);
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "1\n");
    writeFileSync(join(workspace, ".first-tree-workspace", "identity.json"), JSON.stringify({ agentId: "agent-1" }));

    ensureAgentBootstrap({
      workspace,
      sessionCtx: fakeSessionCtx(),
      agentName: "slot-agent",
      contextTreePath: null,
      briefing: "# Current briefing\n",
      currentSourceRepoNames: null,
    });

    expect(bootstrapMocks.bootstrapWorkspace).not.toHaveBeenCalled();
    expect(bootstrapMocks.writeAgentBriefing).toHaveBeenCalledWith(workspace, "# Current briefing\n");
    expect(migrationMocks.applyPendingMigrations).toHaveBeenCalledOnce();
  });

  it("refreshes stable identity when the sentinel is present but identity drifted", () => {
    const sentinel = join(workspace, INIT_COMPLETE_SENTINEL_REL);
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "1\n");
    writeFileSync(join(workspace, ".first-tree-workspace", "identity.json"), "{}");
    bootstrapMocks.deepEqualIdentity.mockReturnValue(false);
    const sessionCtx = fakeSessionCtx();

    ensureAgentBootstrap({
      workspace,
      sessionCtx,
      agentName: "slot-agent",
      contextTreePath: "/tree",
      contextSourceKind: "remote",
      briefing: "briefing\n",
      currentSourceRepoNames: new Set(["source-repos/first-tree"]),
    });

    expect(bootstrapMocks.bootstrapWorkspace).toHaveBeenCalledWith({
      workspacePath: workspace,
      identity: sessionCtx.agent,
      agentName: "slot-agent",
      contextTreePath: "/tree",
      contextSourceKind: "remote",
      serverUrl: "https://hub.test",
    });
    expect(manifestMocks.ensureWorkspaceManifest).toHaveBeenCalledWith(
      workspace,
      ["source-repos/first-tree"],
      sessionCtx.log,
      "context-tree",
      true,
    );
  });

  it("runs the stable bootstrap when init is incomplete and always writes the latest briefing", () => {
    const sessionCtx = fakeSessionCtx();
    ensureAgentBootstrap({
      workspace,
      sessionCtx,
      agentName: "slot-agent",
      contextTreePath: null,
      briefing: "fresh briefing\n",
      currentSourceRepoNames: null,
    });

    expect(bootstrapMocks.bootstrapWorkspace).toHaveBeenCalledWith({
      workspacePath: workspace,
      identity: sessionCtx.agent,
      agentName: "slot-agent",
      contextTreePath: null,
      contextSourceKind: "none",
      serverUrl: "https://hub.test",
    });
    expect(basename(workspace)).not.toBe("slot-agent");
    expect(bootstrapMocks.writeAgentBriefing).toHaveBeenCalledWith(workspace, "fresh briefing\n");
  });

  it("does not republish Local identity, manifest, or briefing after a remote latch exists", () => {
    manifestMocks.workspaceHasRemoteLatch.mockReturnValue(true);
    const sessionCtx = fakeSessionCtx();
    ensureAgentBootstrap({
      workspace,
      sessionCtx,
      agentName: "slot-agent",
      contextTreePath: join(workspace, "local-context"),
      contextSourceKind: "local",
      briefing: "stale local briefing\n",
      currentSourceRepoNames: new Set(["app"]),
    });

    expect(migrationMocks.applyPendingMigrations).toHaveBeenCalledOnce();
    expect(manifestMocks.ensureWorkspaceManifest).not.toHaveBeenCalled();
    expect(bootstrapMocks.bootstrapWorkspace).not.toHaveBeenCalled();
    expect(bootstrapMocks.writeAgentBriefing).not.toHaveBeenCalled();
  });

  it("never writes a workspace manifest without a bound tree, even with resolved source repos", () => {
    // No binding = no manifest: a resolved source set alone must not produce
    // `.first-tree/workspace.json`. Covers both the normal bootstrap path and
    // the sentinel fast path.
    const sessionCtx = fakeSessionCtx();
    ensureAgentBootstrap({
      workspace,
      sessionCtx,
      agentName: "slot-agent",
      contextTreePath: null,
      briefing: "briefing\n",
      currentSourceRepoNames: new Set(["source-repos/first-tree"]),
    });

    expect(manifestMocks.ensureWorkspaceManifest).not.toHaveBeenCalled();

    const sentinel = join(workspace, INIT_COMPLETE_SENTINEL_REL);
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "1\n");
    writeFileSync(join(workspace, ".first-tree-workspace", "identity.json"), JSON.stringify({ agentId: "agent-1" }));

    ensureAgentBootstrap({
      workspace,
      sessionCtx,
      agentName: "slot-agent",
      contextTreePath: null,
      briefing: "briefing\n",
      currentSourceRepoNames: new Set(["source-repos/first-tree"]),
    });

    expect(manifestMocks.ensureWorkspaceManifest).not.toHaveBeenCalled();
  });
});
