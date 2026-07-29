import { parse as parseYaml } from "yaml";
import { MAX_ATTACHMENT_BYTES } from "./attachment.js";

/**
 * One compatible limit set for Server upload validation and Client runtime
 * extraction. A bundle accepted by the Server must remain admissible when a
 * Client installs it.
 */
export const TEAM_SKILL_BUNDLE_LIMITS = Object.freeze({
  compressedBytes: MAX_ATTACHMENT_BYTES,
  entries: 512,
  files: 256,
  totalBytes: 16 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024,
  skillMarkdownBytes: 256 * 1024,
  depth: 16,
  segmentBytes: 240,
  segmentCodeUnits: 120,
  pathBytes: 1024,
  pathCodeUnits: 768,
});

export const TEAM_SKILL_OWNERSHIP_MARKER = ".first-tree-managed.json";
export const TEAM_SKILL_RUNTIME_NAME_MAX = 63;

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

export type TeamSkillBundleEntryPath = Readonly<{
  normalized: string;
  segments: readonly string[];
  directory: boolean;
}>;

export type ParsedTeamSkillMarkdown = Readonly<{
  frontmatter: unknown;
  body: string;
}>;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isPortableSegment(segment: string): boolean {
  if (
    segment.length === 0 ||
    segment.length > TEAM_SKILL_BUNDLE_LIMITS.segmentCodeUnits ||
    new TextEncoder().encode(segment).byteLength > TEAM_SKILL_BUNDLE_LIMITS.segmentBytes ||
    segment === "." ||
    segment === ".." ||
    segment.includes("\\") ||
    containsControlCharacter(segment) ||
    /[<>:"|?*]/u.test(segment) ||
    segment.endsWith(".") ||
    segment.endsWith(" ")
  ) {
    return false;
  }
  const windowsBase = segment.split(".", 1)[0]?.toLocaleLowerCase("en-US") ?? "";
  return !WINDOWS_RESERVED_NAMES.has(windowsBase);
}

/**
 * Validate one raw ZIP entry name without consulting the host filesystem.
 * Forward slashes are the only separators so the same archive has the same
 * meaning on Unix and Windows.
 */
export function parseTeamSkillBundleEntryPath(raw: string): TeamSkillBundleEntryPath | null {
  if (
    raw.length === 0 ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/u.test(raw) ||
    raw.includes("\\") ||
    containsControlCharacter(raw)
  ) {
    return null;
  }
  const directory = raw.endsWith("/");
  const normalized = directory ? raw.slice(0, -1) : raw;
  if (normalized.length === 0) return null;
  if (
    normalized.length > TEAM_SKILL_BUNDLE_LIMITS.pathCodeUnits ||
    new TextEncoder().encode(normalized).byteLength > TEAM_SKILL_BUNDLE_LIMITS.pathBytes
  ) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !isPortableSegment(segment))) return null;
  if (segments.length - 1 > TEAM_SKILL_BUNDLE_LIMITS.depth) return null;
  return { normalized, segments, directory };
}

export function teamSkillBundleCollisionKey(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function isTeamSkillOwnershipMarkerPath(path: string): boolean {
  const firstSegment = path.split("/", 1)[0] ?? "";
  return teamSkillBundleCollisionKey(firstSegment) === teamSkillBundleCollisionKey(TEAM_SKILL_OWNERSHIP_MARKER);
}

/**
 * Parse the exact frontmatter shape used by both Cloud acceptance and Client
 * installation. Keeping the parser and delimiter handling here prevents a ZIP
 * from being accepted by one side and rejected by the other.
 */
export function parseTeamSkillMarkdown(markdown: string): ParsedTeamSkillMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match) throw new Error("SKILL.md must contain YAML frontmatter");
  return {
    frontmatter: parseYaml(match[1] ?? ""),
    body: markdown.slice(match[0].length),
  };
}

/**
 * Return the first path whose explicit parent is declared as a file.
 *
 * ZIPs do not require directory entries, so missing parents are valid. An
 * explicit file parent is not: extraction would otherwise depend on entry
 * order and fail only after upload validation had succeeded. Collision keys
 * deliberately match the case-insensitive target-filesystem policy.
 */
export function teamSkillBundleTopologyConflict(
  entries: readonly Readonly<{ path: string; directory: boolean }>[],
): Readonly<{ path: string; fileParent: string }> | null {
  const pathTypes = new Map(entries.map((entry) => [teamSkillBundleCollisionKey(entry.path), entry.directory]));
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join("/");
      if (pathTypes.get(teamSkillBundleCollisionKey(parent)) === false) {
        return { path: entry.path, fileParent: parent };
      }
    }
  }
  return null;
}
