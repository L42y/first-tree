import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapWorkspace,
  deepEqualIdentity,
  FIRST_TREE_RUNTIME_DIR,
  IDENTITY_JSON_REL,
  writeAgentBriefing,
} from "../runtime/bootstrap.js";
import type { AgentIdentity } from "../runtime/handler.js";
import { AGENT_RUNTIME_STATE_DIRNAME, SOURCE_STATE_FILENAME } from "../runtime/workspace-manifest.js";

// Use a real temp directory for file-based tests
const tmpBase = join(import.meta.dirname ?? __dirname, "../../.test-tmp-bootstrap");

function cleanTmp(): void {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

afterEach(() => {
  cleanTmp();
  vi.restoreAllMocks();
});

function makeIdentity(overrides?: Partial<AgentIdentity>): AgentIdentity {
  return {
    agentId: "test-agent",
    inboxId: "inbox-test-agent",
    displayName: "Test Agent",
    type: "agent",
    visibility: "organization",
    delegateMention: null,
    metadata: {},
    ...overrides,
  };
}

describe("bootstrapWorkspace", () => {
  it("writes identity.json with agent-level stable fields only (no chatId / chatContext)", () => {
    const workspace = join(tmpBase, "ws-identity");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "my-agent", type: "agent", delegateMention: "owner" }),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const identityPath = join(workspace, IDENTITY_JSON_REL);
    expect(existsSync(identityPath)).toBe(true);

    const data = JSON.parse(readFileSync(identityPath, "utf-8"));
    expect(data.agentId).toBe("my-agent");
    expect(data.agentName).toBe("slot-agent");
    expect(data.agentName).not.toBe("ws-identity");
    expect(data.type).toBe("agent");
    expect(data.delegateMention).toBe("owner");
    expect(data.serverUrl).toBe("http://localhost:8000");
    // Per agent-session-cwd-redesign: identity.json holds agent-level state
    // only. chatId / chatContext now live in provider/session prompt injection.
    expect("chatId" in data).toBe(false);
    expect("chatContext" in data).toBe(false);
  });

  it("no longer writes the legacy `.agent/tools.md` (content now lives in AGENTS.md)", () => {
    // Pre-PR-797 the runtime emitted a `.agent/tools.md` stable file that the
    // SDK CLAUDE.md generator referenced. PR 797 collapsed CLAUDE.md and the
    // tools doc into the unified AGENTS.md briefing; this PR completes that
    // by dropping the on-disk `.agent/tools.md` write entirely. The runtime
    // invariants (final-text contract, silent-turn, Issue #389, Decision
    // guide, etc.) are covered by the `buildAgentBriefing` tests.
    const workspace = join(tmpBase, "ws-no-tools-md");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "tools.md"))).toBe(false);
  });

  it("migrates a legacy .agent/ runtime dir into .first-tree-workspace/", () => {
    const workspace = join(tmpBase, "ws-migrate-legacy-agent");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "identity.json"), '{"agentId":"legacy-agent"}');
    writeFileSync(join(workspace, ".first-tree-workspace"), "", "utf-8");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "new-agent" }),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, ".agent"))).toBe(false);
    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR))).toBe(true);
    expect(existsSync(join(workspace, IDENTITY_JSON_REL))).toBe(true);
    expect(lstatSync(join(workspace, FIRST_TREE_RUNTIME_DIR)).isDirectory()).toBe(true);
    const data = JSON.parse(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf-8"));
    expect(data.agentId).toBe("new-agent");
  });

  it("prunes a migrated legacy tools.md during bootstrap", () => {
    const workspace = join(tmpBase, "ws-prune-legacy-tools");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "tools.md"), "legacy tools");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "tools.md"))).toBe(false);
  });

  it("keeps current runtime entries when legacy paths collide during migration", () => {
    const workspace = join(tmpBase, "ws-legacy-collision");
    mkdirSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "dir-wins"), { recursive: true });
    writeFileSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "dir-wins", "keep.txt"), "target-dir");
    writeFileSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "file-wins"), "target-file");
    mkdirSync(join(workspace, ".agent", "file-wins"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "file-wins", "legacy.txt"), "legacy-dir");
    writeFileSync(join(workspace, ".agent", "dir-wins"), "legacy-file");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(lstatSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "dir-wins")).isDirectory()).toBe(true);
    expect(readFileSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "dir-wins", "keep.txt"), "utf-8")).toBe("target-dir");
    expect(lstatSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "file-wins")).isFile()).toBe(true);
    expect(readFileSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "file-wins"), "utf-8")).toBe("target-file");
    expect(existsSync(join(workspace, ".agent"))).toBe(false);
  });

  it("refuses a dangling .first-tree-workspace symlink without following or replacing it", () => {
    const workspace = join(tmpBase, "ws-dangling-runtime-marker");
    mkdirSync(workspace, { recursive: true });
    symlinkSync(join(workspace, "missing-marker-target"), join(workspace, FIRST_TREE_RUNTIME_DIR));

    expect(() =>
      bootstrapWorkspace({
        workspacePath: workspace,
        identity: makeIdentity(),
        agentName: "slot-agent",
        contextTreePath: null,
        serverUrl: "http://localhost:8000",
      }),
    ).toThrow("refusing to use symlinked Agent runtime directory");

    expect(lstatSync(join(workspace, FIRST_TREE_RUNTIME_DIR)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(workspace, "missing-marker-target"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a special .first-tree-workspace entry without deleting or replacing it",
    () => {
      const workspace = join(tmpBase, "ws-fifo-runtime-marker");
      const runtime = join(workspace, FIRST_TREE_RUNTIME_DIR);
      mkdirSync(workspace, { recursive: true });
      execFileSync("mkfifo", [runtime]);

      expect(() =>
        bootstrapWorkspace({
          workspacePath: workspace,
          identity: makeIdentity(),
          agentName: "slot-agent",
          contextTreePath: null,
          serverUrl: "http://localhost:8000",
        }),
      ).toThrow("refusing to replace special Agent runtime entry");

      expect(lstatSync(runtime).isFIFO()).toBe(true);
      expect(existsSync(join(runtime, "identity.json"))).toBe(false);
    },
  );

  it("prunes a legacy `.agent/context/` staging directory on re-bootstrap", () => {
    // Pre-PR-797 the runtime staged `agent-instructions.md` and
    // `domain-map.md` under `.agent/context/`. Those staged copies were
    // unused after the briefing started reading the tree directly, and are
    // now redundant since the unified briefing references the tree by path
    // instead of inlining content. A pre-existing `.agent/context/` from a
    // resumed agent home must therefore be pruned at bootstrap time.
    const workspace = join(tmpBase, "ws-prune-legacy-ctx");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "context", "agent-instructions.md"), "legacy");
    writeFileSync(join(workspace, ".agent", "context", "domain-map.md"), "legacy");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "context"))).toBe(false);
  });

  it("does not write self.md (per PRD D7 — prompt lives in agent_configs)", () => {
    const workspace = join(tmpBase, "ws-no-self-md");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "my-agent" }),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const selfPath = join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "self.md");
    expect(existsSync(selfPath)).toBe(false);
  });

  it("skips context when contextTreePath is null", () => {
    const workspace = join(tmpBase, "ws-no-ctx");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const selfPath = join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "self.md");
    expect(existsSync(selfPath)).toBe(false);
  });

  it("skips context when agent not found in context tree", () => {
    const workspace = join(tmpBase, "ws-missing-agent");
    const ctxTree = join(tmpBase, "context-tree-empty");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(ctxTree, "members"), { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "nonexistent" }),
      agentName: "slot-agent",
      contextTreePath: ctxTree,
      serverUrl: "http://localhost:8000",
    });

    const selfPath = join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "self.md");
    expect(existsSync(selfPath)).toBe(false);
    // identity.json should still exist
    expect(existsSync(join(workspace, IDENTITY_JSON_REL))).toBe(true);
  });

  it("no longer stages AGENT.md / NODE.md under `.agent/context/` (briefing references the tree path instead)", () => {
    // The unified briefing's `## Tree Location` section points the agent at
    // the bound tree checkout directly; the legacy staging copies under
    // `.agent/context/agent-instructions.md` and `.agent/context/domain-map.md`
    // are no longer read by anything and so are no longer written.
    const workspace = join(tmpBase, "ws-no-tree-staging");
    const ctxTree = join(tmpBase, "ctx-tree-no-staging");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(ctxTree, "members", "test-agent"), { recursive: true });
    writeFileSync(join(ctxTree, "AGENT.md"), "## Before Every Task\n\nRead the root NODE.md.");
    writeFileSync(join(ctxTree, "NODE.md"), "# Context Tree\n\n## Domains\n\n- nova/\n");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: ctxTree,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "agent-instructions.md"))).toBe(false);
    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "domain-map.md"))).toBe(false);
    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "context"))).toBe(false);
  });

  it("does not write degraded.md when contextTreePath is null (no Context Tree is normal)", () => {
    const workspace = join(tmpBase, "ws-no-tree");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const degradedPath = join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "degraded.md");
    expect(existsSync(degradedPath)).toBe(false);
  });

  // Per-chat fields (chatId, participants, topic) intentionally have no
  // on-disk home — they flow through provider/session Current Chat Context
  // injection. The shared AGENTS.md / CLAUDE.md briefing must stay stable
  // across sibling chats of the same agent.

  it("overwrites existing files on re-bootstrap", () => {
    const workspace = join(tmpBase, "ws-overwrite");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "identity.json"), '{"agentId":"old"}');

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "new-agent" }),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const data = JSON.parse(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf-8"));
    expect(data.agentId).toBe("new-agent");
  });

  it("does not rewrite identity to Local after a remote latch is on disk", () => {
    const workspace = join(tmpBase, "ws-local-latch");
    mkdirSync(workspace, { recursive: true });
    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: join(workspace, "context-tree"),
      contextSourceKind: "remote",
      serverUrl: "http://localhost:8000",
    });
    mkdirSync(join(workspace, AGENT_RUNTIME_STATE_DIRNAME), { recursive: true });
    writeFileSync(
      join(workspace, AGENT_RUNTIME_STATE_DIRNAME, SOURCE_STATE_FILENAME),
      `${JSON.stringify({
        schemaVersion: 1,
        remoteObserved: true,
        observedAt: "2026-08-13T00:00:00.000Z",
        repoUrl: "git@github.com:acme/tree.git",
        branch: "main",
      })}\n`,
    );
    const before = readFileSync(join(workspace, IDENTITY_JSON_REL), "utf-8");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: join(workspace, "local-context"),
      contextSourceKind: "local",
      serverUrl: "http://localhost:8000",
    });

    expect(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf-8")).toBe(before);
    expect(JSON.parse(before).contextSourceKind).toBe("remote");
  });

  it("refuses to infer agentName from the workspace basename", () => {
    const workspace = join(tmpBase, "looks-like-an-agent-name");
    mkdirSync(workspace, { recursive: true });
    expect(() =>
      bootstrapWorkspace({
        workspacePath: workspace,
        identity: makeIdentity(),
        agentName: "",
        contextTreePath: null,
        serverUrl: "http://localhost:8000",
      }),
    ).toThrow(/refusing to infer agentName/);
  });

  it("replaces an identity.json symlink instead of writing through it", () => {
    const workspace = join(tmpBase, "ws-identity-symlink");
    const outside = join(tmpBase, "outside-identity.json");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(outside, "external-identity\n");
    mkdirSync(join(workspace, FIRST_TREE_RUNTIME_DIR), { recursive: true });
    symlinkSync(outside, join(workspace, IDENTITY_JSON_REL));

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(lstatSync(join(workspace, IDENTITY_JSON_REL)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf-8")).agentName).toBe("slot-agent");
    expect(readFileSync(outside, "utf-8")).toBe("external-identity\n");
  });

  it("replaces an AGENTS.md symlink instead of writing through it", () => {
    const workspace = join(tmpBase, "ws-briefing-symlink");
    const outside = join(tmpBase, "outside-agents.md");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(outside, "external-briefing\n");
    symlinkSync(outside, join(workspace, "AGENTS.md"));

    writeAgentBriefing(workspace, "trusted briefing\n");

    expect(lstatSync(join(workspace, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("trusted briefing\n");
    expect(readFileSync(outside, "utf-8")).toBe("external-briefing\n");
  });
});

describe("deepEqualIdentity", () => {
  it("compares primitives, nested objects, changed values, and extra keys", () => {
    expect(deepEqualIdentity("same", "same")).toBe(true);
    expect(deepEqualIdentity("left", "right")).toBe(false);
    expect(deepEqualIdentity({ metadata: { tier: "prod" } }, { metadata: { tier: "prod" } })).toBe(true);
    expect(deepEqualIdentity({ metadata: { tier: "prod" } }, { metadata: { tier: "dev" } })).toBe(false);
    expect(deepEqualIdentity({ agentId: "agent-1" }, { agentId: "agent-1", displayName: "Agent" })).toBe(false);
    expect(deepEqualIdentity({ agentId: "agent-1" }, { agentId: "agent-1" })).toBe(true);
  });
});
