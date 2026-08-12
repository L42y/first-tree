import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  AGENT_BRIEFING_GENERATED_MARKER,
  type AgentRuntimeConfigPayload,
  type PromptSection,
} from "@first-tree/shared";
import type * as ejs from "ejs";
import type { ContextTreeBindingStatus, PredeclaredSourceRepo } from "./bootstrap.js";
import { getCliBinding } from "./cli-binding.js";
import type { AgentIdentity } from "./handler.js";

// EJS is published as CommonJS at runtime even though its types expose named
// exports, so native ESM cannot import `render` directly. Load lazily so
// `provider-support/index` can re-export preparation without forcing EJS (and
// so capability tests that mock `createRequire` can still import binaries).
let ejsRuntime: typeof ejs | null = null;

function getEjsRuntime(): typeof ejs {
  if (!ejsRuntime) {
    ejsRuntime = createRequire(import.meta.url)("ejs") as typeof ejs;
  }
  return ejsRuntime;
}
const AGENT_BRIEFING_TEMPLATE_FILENAME = "agent-briefing.ejs";
const TEMPLATE_CANDIDATE_URLS = [
  // Source execution and root-level client/CLI chunks keep templates beside
  // this module.
  new URL(`./templates/${AGENT_BRIEFING_TEMPLATE_FILENAME}`, import.meta.url),
  // The shipped CLI entry lives in dist/cli/ (portable: app/cli/) while its
  // copied runtime assets remain at the dist/app root.
  new URL(`../templates/${AGENT_BRIEFING_TEMPLATE_FILENAME}`, import.meta.url),
] as const;
const CONTEXT_TREE_POLICY_CANDIDATE_URLS = [
  // Source execution: packages/client/src/runtime/agent-briefing.ts
  new URL("./assets/context-tree-policy.md", import.meta.url),
  // Root-level client/CLI chunks. This non-discoverable runtime asset is
  // copied beside the built chunks; it is never installed as a Skill.
  new URL("./runtime-assets/context-tree-policy.md", import.meta.url),
  // Shipped CLI and portable entries are nested one level below the copied
  // runtime asset directories.
  new URL("../runtime-assets/context-tree-policy.md", import.meta.url),
] as const;
const CONTEXT_TREE_WRITE_ROUTING_CANDIDATE_URLS = [
  // Source execution: packages/client/src/runtime/agent-briefing.ts
  new URL("./assets/context-tree-write-routing.md", import.meta.url),
  // Root-level client/CLI chunks.
  new URL("./runtime-assets/context-tree-write-routing.md", import.meta.url),
  // Shipped CLI and portable entries are nested one level below the copied
  // runtime asset directories.
  new URL("../runtime-assets/context-tree-write-routing.md", import.meta.url),
] as const;

type CachedTemplate = {
  filename: string;
  source: string;
};

type NamedPromptRow = Readonly<{
  name: string;
  body: string;
}>;

type PromptBodyRow = Readonly<{
  body: string;
}>;

type SourceRepositoryRow = Readonly<{
  absolutePath: string;
  url: string;
  ref: string | null;
  branch: string | null;
}>;

type ContextTreeRenderModel = Readonly<{
  bound: boolean;
  /**
   * Tri-state binding status. The tree-less template sections render ONLY for
   * `explicitly-unbound`; `unresolved` (fetch failure / invalid binding) gets
   * its own wording that never claims "no Context Tree is bound".
   */
  status: ContextTreeBindingStatus;
  path: string | null;
  upstreamUrl: string | null;
  branch: string;
  verifyCommand: string;
  hierarchyHelpCommand: string;
  cloneCommand: string | null;
  removeSymlinkCommand: string | null;
  pullCommand: string | null;
  addWorktreeCommand: string | null;
}>;

export type TeamSkillBriefingRow = Readonly<{
  name: string;
  description: string;
}>;

type AgentBriefingRenderModel = Readonly<{
  bin: string;
  generatedMarker: string;
  identityName: string;
  identityKind: string;
  agentId: string;
  teamPromptRows: ReadonlyArray<NamedPromptRow>;
  agentPromptRows: ReadonlyArray<PromptBodyRow>;
  agentPromptOverrideRows: ReadonlyArray<NamedPromptRow>;
  legacyPrompt: string | null;
  workspacePath: string;
  sourceRepositoryRows: ReadonlyArray<SourceRepositoryRow>;
  exampleSourcePath: string;
  readWorktreePath: string;
  taskWorktreePath: string;
  contextTree: ContextTreeRenderModel;
  contextTreePolicy: string;
  contextTreeWriteRouting: string;
  resourceSkillRows: ReadonlyArray<TeamSkillBriefingRow>;
}>;

let templateCache: CachedTemplate | null = null;
let contextTreePolicyCache: string | null = null;
let contextTreeWriteRoutingCache: string | null = null;

/** Wrap a runtime value in canonical POSIX-safe single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type BuildAgentBriefingOptions = {
  identity: AgentIdentity;
  payload: AgentRuntimeConfigPayload | null;
  workspacePath: string;
  sourceRepos: ReadonlyArray<PredeclaredSourceRepo>;
  /** Successful current-provider rows from the same reconcile result. */
  teamSkills?: ReadonlyArray<TeamSkillBriefingRow>;
  contextTreePath: string | null;
  /** Upstream coordinates used by the agent-managed Context Tree clone. */
  contextTreeRepoUrl?: string | null;
  contextTreeBranch?: string | null;
  /**
   * Tri-state binding status from `resolveAgentContextTreeBinding`. Optional
   * for legacy callers: when omitted it is derived from `contextTreePath`
   * (path ⇒ `bound`, no path ⇒ `explicitly-unbound`), matching the
   * pre-tri-state briefing output. Production callers always pass the
   * resolved status so an `unresolved` state renders its own wording instead
   * of claiming "no Context Tree is bound".
   */
  contextTreeBindingStatus?: ContextTreeBindingStatus;
};

/** Build the unified agent-level briefing materialized as `AGENTS.md`. */
export function buildAgentBriefing(opts: BuildAgentBriefingOptions): string {
  return renderAgentBriefingTemplate(buildAgentBriefingRenderModel(opts));
}

function buildAgentBriefingRenderModel(opts: BuildAgentBriefingOptions): AgentBriefingRenderModel {
  const { binName: bin } = getCliBinding();
  const promptSections = opts.payload?.prompt.sections ?? [];
  const teamPromptRows = buildNamedPromptRows(
    promptSections.filter((section) => section.scope === "team"),
    "Team prompt",
  );
  const agentPromptRows = promptSections
    .filter((section) => section.scope === "agent" && section.editable === true && section.body.trim().length > 0)
    .map((section) => ({ body: section.body.trim() }));
  const agentPromptOverrideRows = buildNamedPromptRows(
    promptSections.filter((section) => section.scope === "agent" && section.editable !== true),
    "Agent prompt override",
  );
  const hasStructuredPrompt =
    teamPromptRows.length > 0 || agentPromptRows.length > 0 || agentPromptOverrideRows.length > 0;
  const legacyPrompt = hasStructuredPrompt ? null : opts.payload?.prompt.append?.trim() || null;

  const sourceRepositoryRows = opts.sourceRepos.map((repo) => ({
    absolutePath: repo.absolutePath,
    url: repo.url,
    ref: repo.ref ?? null,
    branch: repo.branch ?? null,
  }));
  const quotedWorkspacePath = shellQuote(opts.workspacePath);
  const exampleSourcePath = sourceRepositoryRows[0]
    ? shellQuote(sourceRepositoryRows[0].absolutePath)
    : `${quotedWorkspacePath}/source-repos/<source-repo>`;

  return {
    bin,
    generatedMarker: AGENT_BRIEFING_GENERATED_MARKER,
    identityName: opts.identity.displayName ?? opts.identity.agentId,
    identityKind: opts.identity.visibility === "private" ? "a personal assistant agent" : "an autonomous agent",
    agentId: opts.identity.agentId,
    teamPromptRows,
    agentPromptRows,
    agentPromptOverrideRows,
    legacyPrompt,
    workspacePath: opts.workspacePath,
    sourceRepositoryRows,
    exampleSourcePath,
    readWorktreePath: shellQuote(`${opts.workspacePath}/worktrees/<name>-read`),
    taskWorktreePath: shellQuote(`${opts.workspacePath}/worktrees/<task-name>`),
    contextTree: buildContextTreeRenderModel(
      bin,
      opts.contextTreePath,
      opts.contextTreeRepoUrl ?? null,
      opts.contextTreeBranch ?? null,
      opts.contextTreeBindingStatus ?? (opts.contextTreePath !== null ? "bound" : "explicitly-unbound"),
    ),
    contextTreePolicy: readCanonicalContextTreePolicy(),
    contextTreeWriteRouting: readCanonicalContextTreeWriteRouting(),
    resourceSkillRows: (opts.teamSkills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
    })),
  };
}

function buildNamedPromptRows(promptSections: ReadonlyArray<PromptSection>, fallbackName: string): NamedPromptRow[] {
  return promptSections
    .filter((section) => section.body.trim().length > 0)
    .map((section) => ({
      name: section.name.trim() || fallbackName,
      body: section.body.trim(),
    }));
}

function buildContextTreeRenderModel(
  bin: string,
  path: string | null,
  upstreamUrl: string | null,
  configuredBranch: string | null,
  status: ContextTreeBindingStatus,
): ContextTreeRenderModel {
  const branch = configuredBranch ?? "main";
  // The status is authoritative over the coordinates: a non-bound status with
  // a stale non-null path must NOT masquerade as bound (the template renders
  // the bound sections off `bound`), and a bound status without a path
  // degrades to `unresolved` rather than claiming an explicit unbind.
  if (path === null || status !== "bound") {
    return {
      bound: false,
      status: status === "bound" ? "unresolved" : status,
      path: null,
      upstreamUrl: null,
      branch,
      verifyCommand: `${bin} tree verify`,
      hierarchyHelpCommand: `${bin} tree tree --help`,
      cloneCommand: null,
      removeSymlinkCommand: null,
      pullCommand: null,
      addWorktreeCommand: null,
    };
  }

  const quotedPath = shellQuote(path);
  return {
    bound: true,
    status: "bound",
    path,
    upstreamUrl,
    branch,
    verifyCommand: `${bin} tree verify`,
    hierarchyHelpCommand: `${bin} tree tree --help`,
    cloneCommand: upstreamUrl
      ? `git clone --branch ${shellQuote(branch)} --single-branch ${shellQuote(upstreamUrl)} ${quotedPath}`
      : `git clone --branch <branch> --single-branch <tree-repo-url> ${quotedPath}`,
    removeSymlinkCommand: `rm ${quotedPath}`,
    pullCommand: `git -C ${quotedPath} pull --ff-only`,
    addWorktreeCommand: `git -C ${quotedPath} worktree add …`,
  };
}

function renderAgentBriefingTemplate(model: AgentBriefingRenderModel): string {
  const template = readAgentBriefingTemplate();
  return getEjsRuntime().render(template.source, model, { filename: template.filename });
}

function readAgentBriefingTemplate(): CachedTemplate {
  if (templateCache) return templateCache;
  const filename = resolveAgentBriefingTemplatePath();
  templateCache = {
    filename,
    source: readFileSync(filename, "utf8"),
  };
  return templateCache;
}

export function resolveAgentBriefingTemplatePath(): string {
  for (const url of TEMPLATE_CANDIDATE_URLS) {
    const filename = fileURLToPath(url);
    if (existsSync(filename)) return filename;
  }
  throw new Error(
    `Agent briefing EJS template is missing. Expected ${AGENT_BRIEFING_TEMPLATE_FILENAME} in the client runtime templates assets.`,
  );
}

export function resolveCanonicalContextTreePolicyPath(): string {
  for (const url of CONTEXT_TREE_POLICY_CANDIDATE_URLS) {
    const filename = fileURLToPath(url);
    if (existsSync(filename)) return filename;
  }
  throw new Error("Canonical Context Tree policy is missing from the First Tree skill bundle.");
}

export function readCanonicalContextTreePolicy(): string {
  if (contextTreePolicyCache !== null) return contextTreePolicyCache;
  contextTreePolicyCache = readFileSync(resolveCanonicalContextTreePolicyPath(), "utf8");
  return contextTreePolicyCache;
}

export function resolveCanonicalContextTreeWriteRoutingPath(): string {
  for (const url of CONTEXT_TREE_WRITE_ROUTING_CANDIDATE_URLS) {
    const filename = fileURLToPath(url);
    if (existsSync(filename)) return filename;
  }
  throw new Error("Canonical Context Tree write routing contract is missing from the client runtime assets.");
}

/** Read the provider-neutral source-artifact to Tree-write routing contract. */
export function readCanonicalContextTreeWriteRouting(): string {
  if (contextTreeWriteRoutingCache !== null) return contextTreeWriteRoutingCache;
  contextTreeWriteRoutingCache = readFileSync(resolveCanonicalContextTreeWriteRoutingPath(), "utf8").trim();
  return contextTreeWriteRoutingCache;
}

/** Names of the First Tree skills listed by both routing tables. */
export const FIRST_TREE_FAMILY_SKILL_NAMES = [
  "first-tree-welcome",
  "first-tree-write",
  "first-tree-read",
  "first-tree-seed",
  "first-tree-file-bug",
  "context-tree-review",
  "context-tree-audit",
  "first-tree-qa",
] as const;
