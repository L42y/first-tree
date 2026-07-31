import { parseDocument } from "yaml";
import { z } from "zod";

export const SKILL_SOURCES = {
  BUILTIN: "builtin",
  USER: "user",
  PROJECT: "project",
  PLUGIN: "plugin",
} as const;

export const skillSourceSchema = z.enum(["builtin", "user", "project", "plugin"]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

/**
 * Charset for skill `name` / `namespace`. Must match the composer's
 * `detectSlashTrigger` accept-set (`[A-Za-z0-9_-]`); otherwise a SKILL.md
 * that declared `name: "weird thing"` would be uploadable but unreachable
 * — the user would type `/weird` and the popover would close at the
 * space. Keeping schema = composer accept-set makes the contract
 * single-source.
 */
export const SKILL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Static portability contract shared by Team Skill upload validation and
 * Client materialization. A bundle admitted by the Server must fit every
 * supported provider root before any attachment bytes reach an Agent.
 */
export const TEAM_SKILL_BUNDLE_LIMITS = {
  maxFiles: 256,
  maxEntries: 512,
  maxUncompressedBytes: 25 * 1024 * 1024,
  // The installed tree adds First Tree's ownership marker and may rewrite the
  // manifest name to its normalized/collision-safe target. Keep that bounded
  // overhead inside the same portable contract used by Client digests.
  maxMaterializedBytes: 25 * 1024 * 1024 + 64 * 1024,
  maxMaterializedFiles: 257,
  maxSkillMarkdownBytes: 256 * 1024,
  maxDepth: 16,
  maxSegmentUtf8Bytes: 240,
  maxSegmentUtf16CodeUnits: 240,
  maxRelativePathUtf8Bytes: 768,
  maxRelativePathUtf16CodeUnits: 768,
  maxTargetNameLength: 63,
} as const;

export const TEAM_SKILL_OWNERSHIP_MARKER = ".first-tree-managed.json";

// Core identity comes from this exact allowlist, not a `first-tree-*` prefix.
// The `context-tree-*` names are valid Core Skills; Team Skills conflict only
// with exact reserved names.
export const FIRST_TREE_CORE_SKILL_NAMES = [
  "first-tree-welcome",
  "first-tree-seed",
  "first-tree-file-bug",
  "first-tree-qa",
  "first-tree-read",
  "first-tree-write",
  "context-tree-review",
  "context-tree-audit",
] as const;

const RESERVED_CORE_SKILL_SLUGS = new Set<string>(FIRST_TREE_CORE_SKILL_NAMES);
const WINDOWS_RESERVED_NAMES = new Set<string>([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export function foldPortableTeamSkillPath(path: string): string {
  // JavaScript has no native Unicode case-fold primitive. Compatibility
  // normalization followed by lower/upper/lower is a deterministic,
  // conservative key that expands both lowercase and uppercase sharp-S
  // variants (ß/ẞ -> SS -> ss), long-s, and final sigma variants. False
  // positives are safer than admitting two paths that a supported
  // case-insensitive filesystem later merges.
  return path
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .toLocaleUpperCase("en-US")
    .toLocaleLowerCase("en-US")
    .normalize("NFC");
}

/**
 * Record every explicit path and implicit ancestor using the spelling that
 * will reach disk. Portable filesystems may merge NFC/case-fold equivalent
 * directory names even when the complete leaf paths differ.
 */
export function recordPortableTeamSkillPath(canonicalPaths: Map<string, string>, path: string): string | null {
  const segments = path.split("/");
  for (let index = 1; index <= segments.length; index++) {
    const candidate = segments.slice(0, index).join("/");
    const folded = foldPortableTeamSkillPath(candidate);
    const existing = canonicalPaths.get(folded);
    if (existing !== undefined && existing !== candidate) {
      return `portable path spelling collision between "${existing}" and "${candidate}"`;
    }
    canonicalPaths.set(folded, candidate);
  }
  return null;
}

export function getPortableTeamSkillSegmentError(segment: string): string | null {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    containsControlCharacter(segment) ||
    /[<>:"|?*]/u.test(segment) ||
    segment.endsWith(".") ||
    segment.endsWith(" ")
  ) {
    return `unsafe path segment: ${segment}`;
  }
  const normalized = segment.normalize("NFC");
  if (
    new TextEncoder().encode(segment).byteLength > TEAM_SKILL_BUNDLE_LIMITS.maxSegmentUtf8Bytes ||
    segment.length > TEAM_SKILL_BUNDLE_LIMITS.maxSegmentUtf16CodeUnits ||
    new TextEncoder().encode(normalized).byteLength > TEAM_SKILL_BUNDLE_LIMITS.maxSegmentUtf8Bytes ||
    normalized.length > TEAM_SKILL_BUNDLE_LIMITS.maxSegmentUtf16CodeUnits
  ) {
    return `path segment exceeds portable length limits: ${segment}`;
  }
  const windowsBase = normalized.normalize("NFKC").split(".", 1)[0]?.toLocaleLowerCase("en-US") ?? "";
  if (WINDOWS_RESERVED_NAMES.has(windowsBase)) {
    return `Windows-reserved path segment: ${segment}`;
  }
  return null;
}

export function getPortableTeamSkillRelativePathError(
  path: string,
  kind: "file" | "directory" = "file",
): string | null {
  const normalized = path.normalize("NFC");
  if (
    new TextEncoder().encode(path).byteLength > TEAM_SKILL_BUNDLE_LIMITS.maxRelativePathUtf8Bytes ||
    path.length > TEAM_SKILL_BUNDLE_LIMITS.maxRelativePathUtf16CodeUnits ||
    new TextEncoder().encode(normalized).byteLength > TEAM_SKILL_BUNDLE_LIMITS.maxRelativePathUtf8Bytes ||
    normalized.length > TEAM_SKILL_BUNDLE_LIMITS.maxRelativePathUtf16CodeUnits
  ) {
    return `relative path exceeds portable length limits: ${path}`;
  }
  const segments = path.split("/");
  const directoryDepth = kind === "directory" ? segments.length : segments.length - 1;
  if (directoryDepth > TEAM_SKILL_BUNDLE_LIMITS.maxDepth) {
    return `relative path exceeds max directory depth ${TEAM_SKILL_BUNDLE_LIMITS.maxDepth}: ${path}`;
  }
  for (const segment of segments) {
    const error = getPortableTeamSkillSegmentError(segment);
    if (error) return error;
  }
  return null;
}

export function normalizeTeamSkillTargetSlug(input: string): string {
  if (input.includes("/") || input.includes("\\") || containsControlCharacter(input)) {
    throw new Error("Skill name contains a path separator or control character");
  }
  const slug = input
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (
    slug.length === 0 ||
    slug.length > TEAM_SKILL_BUNDLE_LIMITS.maxTargetNameLength ||
    !/^[a-z0-9][a-z0-9-]*$/.test(slug) ||
    WINDOWS_RESERVED_NAMES.has(slug)
  ) {
    throw new Error(`Skill name "${input}" does not produce a portable target slug`);
  }
  if (RESERVED_CORE_SKILL_SLUGS.has(slug)) {
    throw new Error(`Skill name "${input}" is reserved by First Tree`);
  }
  return slug;
}

export type StrictTeamSkillMarkdown = Readonly<{
  frontmatter: Record<string, unknown>;
  body: string;
}>;

/**
 * Parse the exact frontmatter envelope accepted by both Server admission and
 * Client materialization. YAML libraries intentionally accept broader
 * delimiter syntax, which would let configuration succeed for a manifest the
 * provider-side installer cannot discover.
 */
export function parseStrictTeamSkillMarkdown(markdown: string): StrictTeamSkillMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match?.[1]) throw new Error("SKILL.md must contain YAML frontmatter");
  let parsed: unknown;
  try {
    const document = parseDocument(match[1], {
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw document.errors[0] ?? new Error("unknown YAML parse error");
    }
    if (document.warnings.length > 0) {
      throw document.warnings[0] ?? new Error("unknown YAML warning");
    }
    // Aliases can produce cyclic values or expand exponentially. Team Skill
    // metadata is persisted as JSONB and must therefore be a finite JSON tree.
    // Keep native YAML values until after validation. `json: true` would
    // silently coerce tagged binary values into plain `{ type, data }`
    // objects, making a non-JSON manifest appear JSON-safe.
    parsed = document.toJS({ json: false, maxAliasCount: 0 });
    assertFiniteJsonValue(parsed);
  } catch (error) {
    throw new Error(`SKILL.md frontmatter is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping");
  }
  return {
    frontmatter: parsed as Record<string, unknown>,
    body: markdown.slice(match[0].length),
  };
}

function assertFiniteJsonValue(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    nodes++;
    if (nodes > 4_096) throw new Error("frontmatter exceeds the maximum JSON value count");
    if (current.depth > 32) throw new Error("frontmatter exceeds the maximum JSON nesting depth");
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw new Error("frontmatter numbers must be finite");
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value !== "object" || Object.getPrototypeOf(current.value) !== Object.prototype) {
      throw new Error("frontmatter must contain only JSON-safe values");
    }
    for (const item of Object.values(current.value as Record<string, unknown>)) {
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Descriptor for a single agent skill (a.k.a. slash command) discovered by
 * the client. Mirrors the YAML frontmatter of a `SKILL.md` file plus a
 * source tag so the web UI can group / annotate. The recipe is intentionally
 * minimal — the agent runtime owns execution; this row only carries what
 * the UI needs to render the slash-command popover.
 */
export const skillDescriptorSchema = z.object({
  /** Skill name without leading slash. e.g. "review", "ship". */
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(SKILL_NAME_REGEX, "Must start with alphanumeric and contain only [A-Za-z0-9_-]."),
  /** Optional plugin namespace; rendered as `<namespace>:<name>`. */
  namespace: z
    .string()
    .max(120)
    .regex(SKILL_NAME_REGEX, "Must start with alphanumeric and contain only [A-Za-z0-9_-].")
    .optional(),
  /** One-line description used as the popover subtitle. */
  description: z.string().max(2000),
  /** Where this skill came from — used for grouping/labelling in the UI. */
  source: skillSourceSchema,
});
export type SkillDescriptor = z.infer<typeof skillDescriptorSchema>;

export const agentSkillsSchema = z.array(skillDescriptorSchema).max(2000);
export type AgentSkills = z.infer<typeof agentSkillsSchema>;

export const updateAgentSkillsSchema = z.object({
  skills: agentSkillsSchema,
});
export type UpdateAgentSkills = z.infer<typeof updateAgentSkillsSchema>;
