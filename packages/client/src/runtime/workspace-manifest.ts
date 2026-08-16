// Make a cloud agent home a valid W1 workspace so the shipped First Tree
// skills find the binding they expect.
//
// The shipped skills (pre-task hygiene in `first-tree`, and `first-tree-seed`'s
// self-check) locate their binding by walking up from cwd for
// `.first-tree/workspace.json` — a manifest that names the tree subdir (an
// immediate child of the workspace root) and the bound source subdirs (each an
// immediate child of `sourcesRoot`, i.e. `<workspace>/source-repos/<name>`);
// see `@first-tree/shared` `workspaceManifestSchema`.
//
// Per the agent-managed-repos design the Context Tree clone lives directly at
// `<workspace>/context-tree` — a real per-agent clone the agent itself
// maintains (clone-if-missing, pull-before-read; see the briefing protocol in
// `agent-briefing.ts`). Source clones live one level down under
// `<workspace>/source-repos/`. The runtime writes only the manifest here; it
// neither clones nor links anything. Legacy homes may still carry a
// `context-tree` symlink into the retired shared `<dataDir>/context-tree-repos/`
// pool — that link is tolerated (reads through it keep working) until the agent
// replaces it with a real clone per its briefing; the runtime never deletes it.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contextTreeBranchSchema,
  contextTreeRepoSchema,
  SOURCE_REPOS_DIRNAME,
  WORKSPACE_MANIFEST_FILENAME,
  WORKSPACE_STATE_DIRNAME,
  workspaceManifestSchema,
} from "@first-tree/shared";
import {
  atomicWriteTrustedFile,
  ensureTrustedChildDirectory,
  ensureTrustedWorkspaceRoot,
  requireTrustedDirectory,
} from "./trusted-workspace-paths.js";

/**
 * Immediate-subdirectory name under the agent home where the agent maintains
 * its Context Tree clone, and the value written as the manifest's `tree`. A
 * reserved, fixed name (not derived from the repo) so the manifest is stable
 * across tree rebinds and re-clones.
 */
export const CONTEXT_TREE_DIRNAME = "context-tree";

/**
 * Immediate-subdirectory name under the agent home for the Agent-private
 * live Local Context Tree. Distinct from {@link CONTEXT_TREE_DIRNAME} so a
 * frozen Local tree can remain beside a later remote clone.
 */
export const LOCAL_CONTEXT_DIRNAME = "local-context";

/** Runtime state directory that holds identity.json and the remote-observed latch. */
export const AGENT_RUNTIME_STATE_DIRNAME = ".first-tree-workspace";
export const SOURCE_STATE_FILENAME = "source-state.json";
export const CONTEXT_SOURCE_LOCK_FILENAME = "context-source.lock";
export const CONTEXT_SOURCE_LOCK_REL = join(AGENT_RUNTIME_STATE_DIRNAME, CONTEXT_SOURCE_LOCK_FILENAME);
export const SOURCE_STATE_SCHEMA_VERSION = 1 as const;

export type RemoteLatchState = {
  schemaVersion: typeof SOURCE_STATE_SCHEMA_VERSION;
  remoteObserved: true;
  observedAt: string;
  repoUrl: string;
  branch: string;
};

export type RemoteLatchInspection =
  | { status: "absent" }
  | { status: "observed"; state: RemoteLatchState }
  | { status: "unreadable"; reason: "not_regular_file" | "corrupt" | "unsupported_version" };

export type WorkspaceTreeName = typeof CONTEXT_TREE_DIRNAME | typeof LOCAL_CONTEXT_DIRNAME;

/**
 * Ensure `<workspace>/.first-tree/workspace.json` records
 * `{ tree, sources, sourcesRoot }`.
 *
 * A best-effort, idempotent, **never-throws-out** session-bootstrap step. The
 * agent home is shared across the agent's concurrent sessions, so the write
 * tolerates a racing peer and the whole block is wrapped — it must never fail
 * the session it runs in. Defensive rules:
 *   - Validates the manifest BEFORE touching the filesystem.
 *   - Drops source names that can't be immediate-subdir manifest entries
 *     (a nested `localPath` like `a/b`) rather than dropping the whole
 *     manifest; such a source is still materialised on disk, it just can't be
 *     expressed in `sources`. (`sources` are names under `sourcesRoot` =
 *     `source-repos`, i.e. each clone is `<workspace>/source-repos/<name>`.)
 *   - A source named `context-tree` is fine: it lives at
 *     `<workspace>/source-repos/context-tree`, a different namespace from the
 *     tree at `<workspace>/context-tree`, so the schema's `tree ∉ sources`
 *     collision rule does not apply once `sourcesRoot` is set. We always write
 *     `sourcesRoot`, so we never drop the whole manifest over that name.
 *   - A Local tree name is refused only when a remote latch is observed or
 *     the latch file exists but is unreadable. A legacy remote `context-tree`
 *     manifest is not itself authority against an unbound Local switch.
 *     Unknown/none callers must not invoke this helper.
 *
 * The manifest may name a `tree` directory that does not exist yet — the
 * agent clones it on first use per its briefing protocol. The shipped
 * skills already treat a missing tree directory as "not yet materialised",
 * not as an invalid workspace.
 *
 * @param sourceNames immediate-subdir names of the bound source repos (the
 *   agent's resolved `gitRepos` localPaths). Pass the resolved set only — never
 *   call this with an unresolved/empty-as-unknown source set.
 */
export function ensureWorkspaceManifest(
  workspace: string,
  sourceNames: readonly string[],
  log?: (msg: string) => void,
  treeName: WorkspaceTreeName = CONTEXT_TREE_DIRNAME,
  strict = false,
): void {
  const usable = [...sourceNames].filter((name) => {
    if (isImmediateSubdirName(name)) return true;
    log?.(`workspace manifest: dropping source "${name}" — not an immediate subdirectory name`);
    return false;
  });

  if (treeName === LOCAL_CONTEXT_DIRNAME && shouldRefuseLocalManifest(workspace)) {
    const message = "workspace manifest: refusing Local publication; remote latch is observed or unreadable";
    log?.(message);
    if (strict) throw new Error(message);
    return;
  }

  let serialized: string;
  try {
    const manifest = workspaceManifestSchema.parse({
      tree: treeName,
      sources: usable,
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
    serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  } catch (err) {
    log?.(`workspace manifest skipped: ${err instanceof Error ? err.message : String(err)}`);
    if (strict) throw err;
    return;
  }

  try {
    const workspaceRoot = ensureTrustedWorkspaceRoot(workspace);
    const stateDir = ensureTrustedChildDirectory(
      workspaceRoot,
      WORKSPACE_STATE_DIRNAME,
      "Workspace manifest directory",
    );
    const dest = join(stateDir, WORKSPACE_MANIFEST_FILENAME);
    if (treeName === LOCAL_CONTEXT_DIRNAME && shouldRefuseLocalManifest(workspace)) {
      const message = "workspace manifest: remote latch won before local write";
      log?.(message);
      if (strict) throw new Error(message);
      return;
    }
    atomicWriteText(dest, serialized);
    if (strict) {
      const stat = lstatSync(dest);
      const verified = workspaceManifestSchema.parse(JSON.parse(readFileSync(dest, "utf8")));
      if (stat.isSymbolicLink() || !stat.isFile() || verified.tree !== treeName) {
        throw new Error("workspace manifest final verification failed");
      }
    }
  } catch (err) {
    log?.(`workspace manifest write failed: ${err instanceof Error ? err.message : String(err)}`);
    if (strict) throw err;
  }
}

/**
 * Inspect the monotonic remote-observed latch.
 *
 * Only a missing file (`ENOENT`) is `absent` and may authorize Local.
 * A present symlink, non-regular file, corrupt JSON, missing required
 * fields, or future `schemaVersion` is `unreadable` and must fail closed.
 */
export function inspectRemoteLatch(workspace: string): RemoteLatchInspection {
  let workspaceRoot: string;
  try {
    workspaceRoot = requireTrustedDirectory(workspace, "Agent workspace root");
  } catch {
    return { status: "unreadable", reason: "not_regular_file" };
  }
  const runtimeDir = join(workspaceRoot, AGENT_RUNTIME_STATE_DIRNAME);
  try {
    requireTrustedDirectory(runtimeDir, "Context source runtime directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return { status: "unreadable", reason: "not_regular_file" };
  }
  const path = join(runtimeDir, SOURCE_STATE_FILENAME);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return { status: "unreadable", reason: "not_regular_file" };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { status: "unreadable", reason: "not_regular_file" };
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null) {
      return { status: "unreadable", reason: "corrupt" };
    }
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== SOURCE_STATE_SCHEMA_VERSION) {
      return { status: "unreadable", reason: "unsupported_version" };
    }
    const allowedKeys = new Set(["schemaVersion", "remoteObserved", "observedAt", "repoUrl", "branch"]);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
      return { status: "unreadable", reason: "corrupt" };
    }
    if (
      record.remoteObserved !== true ||
      typeof record.observedAt !== "string" ||
      record.observedAt.trim().length === 0 ||
      !contextTreeRepoSchema.safeParse(record.repoUrl).success ||
      !contextTreeBranchSchema.safeParse(record.branch).success
    ) {
      return { status: "unreadable", reason: "corrupt" };
    }
    const repoUrl = record.repoUrl as string;
    const branch = record.branch as string;
    return {
      status: "observed",
      state: {
        schemaVersion: SOURCE_STATE_SCHEMA_VERSION,
        remoteObserved: true,
        observedAt: record.observedAt,
        repoUrl,
        branch,
      },
    };
  } catch {
    return { status: "unreadable", reason: "corrupt" };
  }
}

/** True unless the latch file is truly absent. Corrupt/unknown files block Local. */
export function workspaceHasRemoteLatch(workspace: string): boolean {
  return inspectRemoteLatch(workspace).status !== "absent";
}

function shouldRefuseLocalManifest(workspace: string): boolean {
  return inspectRemoteLatch(workspace).status !== "absent";
}

export function readManifestTreeName(workspace: string): string | null {
  const path = join(workspace, WORKSPACE_STATE_DIRNAME, WORKSPACE_MANIFEST_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || !("tree" in parsed) || typeof parsed.tree !== "string") {
      return null;
    }
    return parsed.tree;
  } catch {
    return null;
  }
}

export function atomicWriteText(path: string, content: string): void {
  atomicWriteTrustedFile(path, content);
}

/** Mirrors `workspaceManifestSchema`'s `subdirectoryNameSchema` rules. */
function isImmediateSubdirName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".." &&
    !name.startsWith(".")
  );
}
