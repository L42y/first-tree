import type { Dirent, Stats } from "node:fs";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

export const LOCAL_CONTEXT_DIRNAME = "local-context";
export const LOCAL_CONTEXT_IDENTITY_REL = join(".first-tree-workspace", "identity.json");
export const LOCAL_CONTEXT_SOURCE_STATE_REL = join(".first-tree-workspace", "source-state.json");

export const LOCAL_CONTEXT_LIMITS = {
  maxDepth: 16,
  maxEntries: 5_000,
  maxFileBytes: 1_048_576,
  maxPathBytes: 1_024,
  maxTotalBytes: 33_554_432,
} as const;

export type LocalContextIntent = "read" | "write";

export type LocalContextBinding =
  | { status: "bound"; branch: string; repoUrl: string }
  | { status: "unbound" }
  | { status: "invalid" };

export type LocalContextTreeStats = {
  entries: number;
  files: number;
  totalBytes: number;
};

export type LocalContextDataLoss = {
  agentName: string;
  path: string;
  storage: "active" | "parked";
};

export type LocalContextResolveResult = {
  agentId: string;
  agentName: string;
  intent: LocalContextIntent;
  path: string;
  repairOnly: boolean;
  stats: LocalContextTreeStats;
  verified: boolean;
};

export type LocalContextScaffold = {
  memberNode: string;
  membersIndex: string;
  rootNode: string;
};

export type ResolveLocalContextOptions = {
  agentId: string;
  agentName: string;
  cwd: string;
  ensure: boolean;
  intent: LocalContextIntent;
  scaffold: LocalContextScaffold;
  serverUrl: string;
  workspaceRoot: string;
};

export type ResolveLocalContextDeps = {
  readBinding(): Promise<LocalContextBinding>;
  recordRemoteBinding(binding: Extract<LocalContextBinding, { status: "bound" }>): Promise<void>;
  verifyTree(treeRoot: string): { ok: boolean };
};

export type LocalContextErrorCode =
  | "LOCAL_CONTEXT_BINDING_INVALID"
  | "LOCAL_CONTEXT_BINDING_UNREADABLE"
  | "LOCAL_CONTEXT_FROZEN"
  | "LOCAL_CONTEXT_IDENTITY_INVALID"
  | "LOCAL_CONTEXT_IDENTITY_MISMATCH"
  | "LOCAL_CONTEXT_LIMIT_EXCEEDED"
  | "LOCAL_CONTEXT_MISSING"
  | "LOCAL_CONTEXT_PATH_INVALID"
  | "LOCAL_CONTEXT_TREE_INVALID";

export class LocalContextError extends Error {
  constructor(
    public readonly code: LocalContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalContextError";
  }
}

/**
 * Agent names become `members/<agentName>/`, so even grandfathered names must
 * remain one visible, platform-independent path segment. This intentionally
 * mirrors the Workspace manifest's immediate-subdirectory contract without
 * requiring current slug syntax from older Agent records.
 */
export function assertLocalContextAgentName(agentName: string): string {
  if (
    agentName.length === 0 ||
    agentName === "." ||
    agentName === ".." ||
    agentName.startsWith(".") ||
    agentName.includes("/") ||
    agentName.includes("\\")
  ) {
    throw new LocalContextError(
      "LOCAL_CONTEXT_PATH_INVALID",
      "Local Context Agent name must be one non-hidden immediate directory name without path separators.",
    );
  }
  return agentName;
}

const identitySchema = z
  .object({
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    contextSourceKind: z.literal("local"),
    contextTreePath: z.string().min(1),
    serverUrl: z.string().url(),
  })
  .passthrough();

const remoteLatchSchema = z
  .object({
    branch: z.string().min(1),
    observedAt: z.string().min(1),
    remoteObserved: z.literal(true),
    repoUrl: z.string().min(1),
    schemaVersion: z.literal(1),
  })
  .strict();

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString();
}

function isPathInsideOrEqual(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function requireRealDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  let entry: Stats;
  try {
    entry = lstatSync(absolute);
  } catch {
    throw new LocalContextError("LOCAL_CONTEXT_PATH_INVALID", `${label} does not exist: ${absolute}`);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new LocalContextError("LOCAL_CONTEXT_PATH_INVALID", `${label} must be a real directory: ${absolute}`);
  }
  const canonical = realpathSync(absolute);
  if (canonical !== absolute) {
    throw new LocalContextError(
      "LOCAL_CONTEXT_PATH_INVALID",
      `${label} must not traverse a symlinked or aliased ancestor: ${absolute}`,
    );
  }
  return canonical;
}

function readIdentity(path: string): z.infer<typeof identitySchema> {
  const runtimeDir = requireRealDirectory(resolve(path, ".."), "Agent runtime state directory");
  if (join(runtimeDir, "identity.json") !== path) {
    throw new LocalContextError(
      "LOCAL_CONTEXT_IDENTITY_INVALID",
      "Runtime identity parent must not be a symlink or path alias.",
    );
  }
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch {
    throw new LocalContextError("LOCAL_CONTEXT_IDENTITY_INVALID", `Runtime identity is missing: ${path}`);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new LocalContextError(
      "LOCAL_CONTEXT_IDENTITY_INVALID",
      "Runtime identity must be a regular file and must not be a symlink.",
    );
  }
  try {
    return identitySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new LocalContextError("LOCAL_CONTEXT_IDENTITY_INVALID", "Runtime identity is malformed or incomplete.");
  }
}

function assertNoRemoteLatch(workspaceRoot: string): void {
  const path = join(workspaceRoot, LOCAL_CONTEXT_SOURCE_STATE_REL);
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT") {
      return;
    }
    throw new LocalContextError("LOCAL_CONTEXT_FROZEN", "Remote-observed state exists but cannot be inspected.");
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new LocalContextError("LOCAL_CONTEXT_FROZEN", "Remote-observed state is not a trusted regular file.");
  }

  try {
    remoteLatchSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new LocalContextError(
      "LOCAL_CONTEXT_FROZEN",
      "Remote-observed state exists but its schema is corrupt or unsupported; Local Context remains frozen.",
    );
  }

  throw new LocalContextError(
    "LOCAL_CONTEXT_FROZEN",
    "This Agent Workspace has observed a remote Context Tree binding; Local Context cannot be reactivated.",
  );
}

export function formatLocalContextLossWarning(workspacePath: string): string | null {
  const treeRoot = join(workspacePath, LOCAL_CONTEXT_DIRNAME);
  if (!existsSync(treeRoot)) return null;
  return (
    `Workspace ${workspacePath} contains Agent-private Local Context at ${treeRoot}. ` +
    "Deleting this workspace permanently discards that tree; it is not uploaded and cannot be restored from a remote Context Tree."
  );
}

function createFileIfAbsent(path: string, content: string): void {
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "EEXIST") {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new LocalContextError(
          "LOCAL_CONTEXT_PATH_INVALID",
          `Scaffold entry must be a regular file and must not be a symlink: ${path}`,
        );
      }
      return;
    }
    throw error;
  }
}

function ensureDirectDirectory(parentReal: string, path: string, label: string): { created: boolean; real: string } {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "EEXIST")) {
      throw error;
    }
  }
  const real = requireRealDirectory(path, label);
  if (real !== path || !isPathInsideOrEqual(parentReal, real)) {
    throw new LocalContextError(
      "LOCAL_CONTEXT_PATH_INVALID",
      `${label} must be a real direct descendant of its trusted parent.`,
    );
  }
  return { created, real };
}

function ensureScaffold(
  workspaceReal: string,
  treeRoot: string,
  agentName: string,
  scaffold: LocalContextScaffold,
  intent: LocalContextIntent,
): void {
  // The atomic mkdir result owns first materialization: only the call that
  // actually creates the Local root may scaffold it for any intent. An
  // EEXIST root is an existing Tree — a read intent must not create, rewrite,
  // or repair any scaffold bytes (an interrupted writer's gaps surface via
  // inspect + tree verify as LOCAL_CONTEXT_TREE_INVALID); only write intent
  // may mechanically repair it.
  const root = ensureDirectDirectory(workspaceReal, treeRoot, "Local Context root");
  if (!root.created && intent === "read") {
    return;
  }
  const members = ensureDirectDirectory(root.real, join(root.real, "members"), "Local Context members directory");
  createFileIfAbsent(join(treeRoot, "NODE.md"), scaffold.rootNode);
  createFileIfAbsent(join(members.real, "NODE.md"), scaffold.membersIndex);
  const memberDir = ensureDirectDirectory(
    members.real,
    join(members.real, agentName),
    "Local Context Agent member directory",
  );
  createFileIfAbsent(join(memberDir.real, "NODE.md"), scaffold.memberNode);
}

function inspectLocalContextTreeUnchecked(treeRoot: string): LocalContextTreeStats {
  const rootReal = requireRealDirectory(treeRoot, "Local Context root");
  const stats: LocalContextTreeStats = { entries: 0, files: 0, totalBytes: 0 };

  const visit = (directory: string, depth: number): void => {
    if (depth > LOCAL_CONTEXT_LIMITS.maxDepth) {
      throw new LocalContextError(
        "LOCAL_CONTEXT_LIMIT_EXCEEDED",
        `Local Context exceeds the maximum directory depth (${LOCAL_CONTEXT_LIMITS.maxDepth}).`,
      );
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      stats.entries += 1;
      if (stats.entries > LOCAL_CONTEXT_LIMITS.maxEntries) {
        throw new LocalContextError(
          "LOCAL_CONTEXT_LIMIT_EXCEEDED",
          `Local Context exceeds the maximum entry count (${LOCAL_CONTEXT_LIMITS.maxEntries}).`,
        );
      }

      const path = join(directory, entry.name);
      const rel = relative(rootReal, path).replace(/\\/gu, "/");
      if (Buffer.byteLength(rel, "utf8") > LOCAL_CONTEXT_LIMITS.maxPathBytes) {
        throw new LocalContextError(
          "LOCAL_CONTEXT_LIMIT_EXCEEDED",
          `Local Context path exceeds ${LOCAL_CONTEXT_LIMITS.maxPathBytes} bytes: ${rel}`,
        );
      }

      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new LocalContextError("LOCAL_CONTEXT_PATH_INVALID", `Local Context must not contain symlinks: ${rel}`);
      }
      if (metadata.isDirectory()) {
        const real = realpathSync(path);
        if (!isPathInsideOrEqual(rootReal, real)) {
          throw new LocalContextError("LOCAL_CONTEXT_PATH_INVALID", `Local Context path escapes its root: ${rel}`);
        }
        visit(real, depth + 1);
        continue;
      }
      if (!metadata.isFile()) {
        throw new LocalContextError(
          "LOCAL_CONTEXT_PATH_INVALID",
          `Local Context contains an unsupported special file: ${rel}`,
        );
      }
      if (metadata.size > LOCAL_CONTEXT_LIMITS.maxFileBytes) {
        throw new LocalContextError(
          "LOCAL_CONTEXT_LIMIT_EXCEEDED",
          `Local Context file exceeds ${LOCAL_CONTEXT_LIMITS.maxFileBytes} bytes: ${rel}`,
        );
      }
      stats.files += 1;
      stats.totalBytes += metadata.size;
      if (stats.totalBytes > LOCAL_CONTEXT_LIMITS.maxTotalBytes) {
        throw new LocalContextError(
          "LOCAL_CONTEXT_LIMIT_EXCEEDED",
          `Local Context exceeds ${LOCAL_CONTEXT_LIMITS.maxTotalBytes} total bytes.`,
        );
      }
    }
  };

  visit(rootReal, 0);
  return stats;
}

export function inspectLocalContextTree(treeRoot: string): LocalContextTreeStats {
  try {
    return inspectLocalContextTreeUnchecked(treeRoot);
  } catch (error) {
    if (error instanceof LocalContextError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new LocalContextError(
      "LOCAL_CONTEXT_PATH_INVALID",
      `Local Context structure could not be inspected safely: ${detail}`,
    );
  }
}

function listWorkspaceLocalContexts(workspacesRoot: string, storage: "active" | "parked"): LocalContextDataLoss[] {
  if (!existsSync(workspacesRoot)) return [];
  let agents: Dirent[];
  try {
    agents = readdirSync(workspacesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return agents.flatMap((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
    const path = join(workspacesRoot, entry.name, LOCAL_CONTEXT_DIRNAME);
    try {
      const local = lstatSync(path);
      return local.isDirectory() && !local.isSymbolicLink()
        ? [{ agentName: entry.name, path, storage } satisfies LocalContextDataLoss]
        : [];
    } catch {
      return [];
    }
  });
}

/** Enumerate Local Context directories an explicit purge/reset would delete. */
export function listLocalContextDataLoss(options: { dataDir: string; home: string }): LocalContextDataLoss[] {
  const found = listWorkspaceLocalContexts(join(options.dataDir, "workspaces"), "active");
  const parkedRoot = join(options.home, "parked-clients");
  if (!existsSync(parkedRoot)) return found;
  let clients: Dirent[];
  try {
    clients = readdirSync(parkedRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const client of clients) {
    if (!client.isDirectory() || client.isSymbolicLink()) continue;
    found.push(...listWorkspaceLocalContexts(join(parkedRoot, client.name, "data", "workspaces"), "parked"));
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

export function localContextDataLossForAgent(workspacesRoot: string, agentName: string): LocalContextDataLoss | null {
  return listWorkspaceLocalContexts(workspacesRoot, "active").find((entry) => entry.agentName === agentName) ?? null;
}

async function resolveLocalContextUnchecked(
  options: ResolveLocalContextOptions,
  deps: ResolveLocalContextDeps,
): Promise<LocalContextResolveResult> {
  assertLocalContextAgentName(options.agentName);
  const workspace = resolve(options.workspaceRoot);
  const workspaceReal = requireRealDirectory(workspace, "Agent Workspace");
  if (workspaceReal !== workspace) {
    throw new LocalContextError(
      "LOCAL_CONTEXT_PATH_INVALID",
      "Agent Workspace must resolve to its configured canonical path.",
    );
  }
  let cwdReal: string;
  try {
    cwdReal = realpathSync(resolve(options.cwd));
  } catch {
    throw new LocalContextError("LOCAL_CONTEXT_PATH_INVALID", "The current working directory cannot be resolved.");
  }
  if (!isPathInsideOrEqual(workspaceReal, cwdReal)) {
    throw new LocalContextError(
      "LOCAL_CONTEXT_PATH_INVALID",
      "Local Context must be resolved from inside the active Agent Workspace.",
    );
  }

  const configuredLocalRoot = join(workspace, LOCAL_CONTEXT_DIRNAME);
  const localRoot = join(workspaceReal, LOCAL_CONTEXT_DIRNAME);
  const identity = readIdentity(join(workspaceReal, LOCAL_CONTEXT_IDENTITY_REL));
  if (
    identity.agentName !== options.agentName ||
    identity.agentId !== options.agentId ||
    normalizeServerUrl(identity.serverUrl) !== normalizeServerUrl(options.serverUrl) ||
    resolve(identity.contextTreePath) !== configuredLocalRoot
  ) {
    throw new LocalContextError(
      "LOCAL_CONTEXT_IDENTITY_MISMATCH",
      "Runtime identity does not match the local Agent configuration, server, or fixed Local Context path.",
    );
  }

  const requireCurrentUnbound = async (): Promise<void> => {
    assertNoRemoteLatch(workspaceReal);
    let binding: LocalContextBinding;
    try {
      binding = await deps.readBinding();
    } catch {
      throw new LocalContextError(
        "LOCAL_CONTEXT_BINDING_UNREADABLE",
        "The server binding could not be read; Local Context is not authorized.",
      );
    }
    if (binding.status === "bound") {
      try {
        await deps.recordRemoteBinding(binding);
      } catch {
        throw new LocalContextError(
          "LOCAL_CONTEXT_FROZEN",
          "A remote binding was observed but its monotonic latch could not be recorded safely; Local Context remains frozen.",
        );
      }
      throw new LocalContextError(
        "LOCAL_CONTEXT_FROZEN",
        "The Team now has a remote Context Tree binding; Local Context is frozen.",
      );
    }
    if (binding.status !== "unbound") {
      throw new LocalContextError(
        "LOCAL_CONTEXT_BINDING_INVALID",
        "The server reported an invalid Context Tree binding; Local Context is not authorized.",
      );
    }
    assertNoRemoteLatch(workspaceReal);
  };

  await requireCurrentUnbound();

  if (!existsSync(localRoot) && !options.ensure) {
    throw new LocalContextError("LOCAL_CONTEXT_MISSING", "Local Context does not exist; retry with --ensure.");
  }
  if (options.ensure) {
    ensureScaffold(workspaceReal, localRoot, options.agentName, options.scaffold, options.intent);
  }

  const localRootReal = requireRealDirectory(localRoot, "Local Context root");
  if (localRootReal !== localRoot || !isPathInsideOrEqual(workspaceReal, localRootReal)) {
    throw new LocalContextError(
      "LOCAL_CONTEXT_PATH_INVALID",
      "Local Context must be the real fixed local-context directory inside the Agent Workspace.",
    );
  }

  const stats = inspectLocalContextTree(localRootReal);
  const verified = deps.verifyTree(localRootReal).ok;
  await requireCurrentUnbound();
  if (!verified && options.intent === "read") {
    throw new LocalContextError(
      "LOCAL_CONTEXT_TREE_INVALID",
      "Local Context failed tree verify and cannot be read; use Local Write only to repair the live Tree.",
    );
  }

  return {
    agentId: options.agentId,
    agentName: options.agentName,
    intent: options.intent,
    path: localRootReal,
    repairOnly: !verified,
    stats,
    verified,
  };
}

export async function resolveLocalContext(
  options: ResolveLocalContextOptions,
  deps: ResolveLocalContextDeps,
): Promise<LocalContextResolveResult> {
  try {
    return await resolveLocalContextUnchecked(options, deps);
  } catch (error) {
    if (error instanceof LocalContextError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new LocalContextError(
      "LOCAL_CONTEXT_PATH_INVALID",
      `Local Context could not be resolved through trusted filesystem entries: ${detail}`,
    );
  }
}
