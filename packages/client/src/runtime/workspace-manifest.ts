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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SOURCE_REPOS_DIRNAME,
  WORKSPACE_MANIFEST_FILENAME,
  WORKSPACE_STATE_DIRNAME,
  workspaceManifestSchema,
} from "@first-tree/shared";

/**
 * Immediate-subdirectory name under the agent home where the agent maintains
 * its Context Tree clone, and the value written as the manifest's `tree`. A
 * reserved, fixed name (not derived from the repo) so the manifest is stable
 * across tree rebinds and re-clones.
 */
export const CONTEXT_TREE_DIRNAME = "context-tree";

/**
 * Name the runtime-generated manifest is renamed to when the server
 * affirmatively reports the agent's Context Tree binding as removed. Retired
 * rather than hard-deleted per repo convention, so an operator can inspect
 * what the workspace last declared.
 */
export const RETIRED_WORKSPACE_MANIFEST_FILENAME = `${WORKSPACE_MANIFEST_FILENAME}.retired`;

/**
 * Retire `<workspace>/.first-tree/workspace.json` by renaming it to
 * `workspace.json.retired`, replacing any prior retired file. Idempotent
 * no-op when no manifest exists. Never touches `<workspace>/context-tree/` —
 * without a manifest that checkout is inert residue the agent may still hold
 * local state in.
 *
 * A prior archive is removed before the rename: POSIX `rename` overwrites an
 * existing target, but Windows does not — without the removal a repeated
 * unbind/rebind cycle would fail there and leave the ACTIVE manifest in
 * place. The archive is derived state, so dropping the older copy is safe.
 *
 * Called only on an EXPLICIT unbind (the server returned `repo: null`). An
 * unresolved binding (fetch failure / invalid payload) must keep the
 * last-known-good manifest, so callers must never route that state here.
 *
 * Same never-throws-out contract as {@link ensureWorkspaceManifest}: the
 * agent home is shared across concurrent sessions and a retirement failure
 * must not fail the session it runs in.
 */
export function retireWorkspaceManifest(workspace: string, log?: (msg: string) => void): void {
  try {
    const stateDir = join(workspace, WORKSPACE_STATE_DIRNAME);
    const manifestPath = join(stateDir, WORKSPACE_MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) return;
    const retiredPath = join(stateDir, RETIRED_WORKSPACE_MANIFEST_FILENAME);
    rmSync(retiredPath, { force: true });
    renameSync(manifestPath, retiredPath);
  } catch (err) {
    log?.(`workspace manifest retirement failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Ensure `<workspace>/.first-tree/workspace.json` records
 * `{ tree, sources?, sourcesRoot }`.
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
 *
 * The manifest may name a `tree` directory that does not exist yet — the
 * agent clones it on first use per its briefing protocol. The shipped
 * skills already treat a missing tree directory as "not yet materialised",
 * not as an invalid workspace.
 *
 * @param sourceNames immediate-subdir names of the bound source repos (the
 *   agent's resolved `gitRepos` localPaths), or `null` when the source set is
 *   unresolved (config/cache miss). `null` never publishes unknown as
 *   resolved-empty: the `sources` key is omitted, and when an existing valid
 *   manifest already declares sources those last-known names are preserved so
 *   a transient resolution failure does not clobber last-known-good state.
 *   Once the source set resolves again the manifest refills via the normal
 *   overwrite path.
 */
export function ensureWorkspaceManifest(
  workspace: string,
  sourceNames: readonly string[] | null,
  log?: (msg: string) => void,
): void {
  // Drop names that can't be immediate-subdir manifest entries (nested
  // `localPath`). Better than failing the whole manifest write.
  const usable = sourceNames?.filter((name) => {
    if (isImmediateSubdirName(name)) return true;
    log?.(`workspace manifest: dropping source "${name}" — not an immediate subdirectory name`);
    return false;
  });

  // Unresolved source set: keep the last-known declared sources from an
  // existing valid manifest; otherwise omit the key entirely.
  const sources = usable ?? readDeclaredSources(workspace);

  // Validate (and pre-serialize) BEFORE any filesystem mutation.
  let serialized: string;
  try {
    const manifest = workspaceManifestSchema.parse({
      tree: CONTEXT_TREE_DIRNAME,
      ...(sources !== undefined ? { sources } : {}),
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
    serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  } catch (err) {
    log?.(`workspace manifest skipped: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    const stateDir = join(workspace, WORKSPACE_STATE_DIRNAME);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, WORKSPACE_MANIFEST_FILENAME), serialized, "utf-8");
  } catch (err) {
    log?.(`workspace manifest write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Read the declared `sources` from an existing valid manifest, or `undefined`
 * when there is none (missing, corrupt, or itself sources-less). Used to
 * preserve last-known-good sources across a transient resolution gap. Never
 * throws.
 */
function readDeclaredSources(workspace: string): string[] | undefined {
  try {
    const manifestPath = join(workspace, WORKSPACE_STATE_DIRNAME, WORKSPACE_MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) return undefined;
    const parsed = workspaceManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf-8")));
    return parsed.success ? parsed.data.sources : undefined;
  } catch {
    return undefined;
  }
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
