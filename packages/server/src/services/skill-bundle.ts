import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  foldPortableTeamSkillPath,
  getPortableTeamSkillRelativePathError,
  getPortableTeamSkillSegmentError,
  normalizeTeamSkillTargetSlug,
  parseStrictTeamSkillMarkdown,
  recordPortableTeamSkillPath,
  SKILL_NAME_REGEX,
  type SkillResourcePayload,
  skillResourcePayloadSchema,
  TEAM_SKILL_BUNDLE_LIMITS,
  TEAM_SKILL_OWNERSHIP_MARKER,
} from "@first-tree/shared";
import { and, eq, isNull } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { resources } from "../db/schema/resources.js";
import { BadRequestError } from "../errors.js";
import {
  type AttachmentObjectQuota,
  createAttachment,
  deleteAttachmentIfUnreferenced,
  loadAttachmentMeta,
  openAttachmentStream,
} from "./attachment.js";
import type { AttachmentBlobStore } from "./attachment-blob-store.js";

export type ValidatedSkillBundle = {
  name: string;
  payload: SkillResourcePayload;
};

/**
 * Validate one complete Skill directory without executing or extracting any
 * uploaded file. The PostgreSQL-backed ZIP is streamed to a temporary file so
 * entry validation stays bounded.
 */
export async function validateSkillBundle(
  db: Database,
  blobStore: AttachmentBlobStore,
  organizationId: string,
  attachmentId: string,
): Promise<ValidatedSkillBundle> {
  const meta = await loadAttachmentMeta(db, attachmentId);
  if (!meta || meta.organizationId !== organizationId) {
    throw new BadRequestError("Skill bundle attachment must be a ready attachment owned by this organization");
  }
  const stream = await openAttachmentStream(db, blobStore, attachmentId);
  if (!stream) throw new BadRequestError("Skill bundle attachment bytes are unavailable");

  const tempDir = await mkdtemp(join(tmpdir(), "first-tree-skill-"));
  const zipPath = join(tempDir, "bundle.zip");
  try {
    await pipeline(stream, createWriteStream(zipPath, { flags: "wx" }));
    return await inspectZip(zipPath);
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    throw new BadRequestError(`Invalid Skill ZIP: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function inspectZip(path: string): Promise<ValidatedSkillBundle> {
  const zipFile = await openZip(path);
  const seenPaths = new Set<string>();
  const entries: Array<{ path: string; kind: "directory" | "file" }> = [];
  const skillMarkdown = new Map<string, Buffer>();
  let entryCount = 0;
  let fileCount = 0;
  let totalUncompressed = 0;

  try {
    await forEachEntry(zipFile, async (entry) => {
      const normalized = validateEntryPath(entry.fileName);
      entryCount++;
      if (entryCount > TEAM_SKILL_BUNDLE_LIMITS.maxEntries) {
        throw new BadRequestError(`Skill ZIP cannot contain more than ${TEAM_SKILL_BUNDLE_LIMITS.maxEntries} entries`);
      }
      const collisionKey = foldPortableTeamSkillPath(normalized);
      if (seenPaths.has(collisionKey)) {
        throw new BadRequestError(`Skill ZIP contains a duplicate path: ${normalized}`);
      }
      seenPaths.add(collisionKey);
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        throw new BadRequestError(`Skill ZIP contains an encrypted entry: ${normalized}`);
      }
      const kind = zipEntryKind(entry, normalized);
      if (kind === "directory" && entry.uncompressedSize !== 0) {
        throw new BadRequestError(`Skill ZIP directory entry contains data: ${normalized}`);
      }
      entries.push({ path: normalized, kind });
      if (kind === "directory") return;

      fileCount++;
      if (fileCount > TEAM_SKILL_BUNDLE_LIMITS.maxFiles) {
        throw new BadRequestError(`Skill ZIP cannot contain more than ${TEAM_SKILL_BUNDLE_LIMITS.maxFiles} files`);
      }
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > TEAM_SKILL_BUNDLE_LIMITS.maxUncompressedBytes) {
        throw new BadRequestError(
          `Skill ZIP exceeds ${TEAM_SKILL_BUNDLE_LIMITS.maxUncompressedBytes} uncompressed bytes`,
        );
      }

      const isSkillMarkdown = basename(normalized).toLocaleLowerCase("en-US") === "skill.md";
      if (isSkillMarkdown && entry.uncompressedSize > TEAM_SKILL_BUNDLE_LIMITS.maxSkillMarkdownBytes) {
        throw new BadRequestError(`SKILL.md exceeds ${TEAM_SKILL_BUNDLE_LIMITS.maxSkillMarkdownBytes} bytes`);
      }
      const bytes = await readEntry(
        zipFile,
        entry,
        isSkillMarkdown ? TEAM_SKILL_BUNDLE_LIMITS.maxSkillMarkdownBytes : 0,
      );
      if (isSkillMarkdown) skillMarkdown.set(normalized, bytes);
    });
  } finally {
    zipFile.close();
  }

  if (skillMarkdown.size !== 1) {
    throw new BadRequestError("Skill ZIP must contain exactly one SKILL.md");
  }
  const skillEntry = skillMarkdown.entries().next().value;
  if (!skillEntry) throw new BadRequestError("Skill ZIP must contain SKILL.md");
  const [skillPath, bytes] = skillEntry;
  const segments = skillPath.split("/");
  if (segments.length > 2 || segments.at(-1) !== "SKILL.md") {
    throw new BadRequestError("SKILL.md must be at the ZIP root or inside one top-level directory");
  }
  const wrapper = segments.length === 2 ? segments[0] : null;
  const rootPrefix = wrapper ? `${wrapper}/` : "";
  if (wrapper && entries.some((entry) => entry.path !== wrapper && !entry.path.startsWith(rootPrefix))) {
    throw new BadRequestError("A wrapped Skill ZIP cannot contain files outside its top-level directory");
  }
  if (wrapper && entries.some((entry) => entry.path === wrapper && entry.kind !== "directory")) {
    throw new BadRequestError("A wrapped Skill ZIP anchor must be a directory");
  }

  const outputKinds = new Map<string, "directory" | "file">();
  const canonicalOutputPaths = new Map<string, string>();
  for (const entry of entries) {
    const targetPath = wrapper ? (entry.path === wrapper ? "" : entry.path.slice(rootPrefix.length)) : entry.path;
    if (!targetPath) continue;
    const portableError = getPortableTeamSkillRelativePathError(targetPath, entry.kind);
    if (portableError) throw new BadRequestError(`Skill ZIP contains ${portableError}`);
    const firstSegment = targetPath.split("/", 1)[0] ?? "";
    if (foldPortableTeamSkillPath(firstSegment) === foldPortableTeamSkillPath(TEAM_SKILL_OWNERSHIP_MARKER)) {
      throw new BadRequestError(`Skill ZIP may not provide reserved file ${TEAM_SKILL_OWNERSHIP_MARKER}`);
    }
    const spellingCollision = recordPortableTeamSkillPath(canonicalOutputPaths, targetPath);
    if (spellingCollision) {
      throw new BadRequestError(`Skill ZIP contains ${spellingCollision}`);
    }
    const folded = foldPortableTeamSkillPath(targetPath);
    if (outputKinds.has(folded)) {
      throw new BadRequestError(`Skill ZIP contains a duplicate extracted path: ${targetPath}`);
    }
    outputKinds.set(folded, entry.kind);
  }
  for (const [path, kind] of outputKinds) {
    if (kind !== "file") continue;
    for (const candidate of outputKinds.keys()) {
      if (candidate.startsWith(`${path}/`)) {
        throw new BadRequestError(`Skill ZIP file is used as a directory: ${candidate}`);
      }
    }
  }

  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequestError("SKILL.md must be valid UTF-8");
  }
  let parsed: ReturnType<typeof parseStrictTeamSkillMarkdown>;
  try {
    parsed = parseStrictTeamSkillMarkdown(markdown);
  } catch (error) {
    throw new BadRequestError(`SKILL.md frontmatter is invalid: ${error instanceof Error ? error.message : error}`);
  }
  const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : "";
  const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";
  const namespace = typeof parsed.frontmatter.namespace === "string" ? parsed.frontmatter.namespace.trim() : undefined;
  if (!name || name.length > 100 || !SKILL_NAME_REGEX.test(name)) {
    throw new BadRequestError("SKILL.md name must start with an alphanumeric and contain only letters, digits, _ or -");
  }
  try {
    normalizeTeamSkillTargetSlug(name);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : "Skill name is not portable");
  }
  if (!description || description.length > 1_000) {
    throw new BadRequestError("SKILL.md description is required and must be at most 1000 characters");
  }
  if (namespace && (namespace.length > 100 || !SKILL_NAME_REGEX.test(namespace))) {
    throw new BadRequestError("SKILL.md namespace must contain only letters, digits, _ or -");
  }
  const rawMetadata = parsed.frontmatter.metadata;
  const metadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {};
  const payload = skillResourcePayloadSchema.parse({
    name,
    ...(namespace ? { namespace } : {}),
    description,
    body: parsed.body.trim(),
    metadata,
  });
  return { name, payload };
}

function validateEntryPath(raw: string): string {
  if (!raw || raw.includes("\0") || raw.includes("\\")) {
    throw new BadRequestError("Skill ZIP contains an invalid path");
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new BadRequestError(`Skill ZIP contains an absolute path: ${raw}`);
  }
  const withoutTrailingSlash = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments = withoutTrailingSlash.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new BadRequestError(`Skill ZIP contains an unsafe path: ${raw}`);
  }
  for (const segment of segments) {
    const portableError = getPortableTeamSkillSegmentError(segment);
    if (portableError) throw new BadRequestError(`Skill ZIP contains ${portableError}`);
  }
  return withoutTrailingSlash;
}

function zipEntryKind(entry: Entry, normalizedPath: string): "directory" | "file" {
  const unixMode = entry.versionMadeBy >>> 8 === 3 ? entry.externalFileAttributes >>> 16 : 0;
  const unixType = unixMode & 0o170000;
  if (unixType === 0o120000) throw new BadRequestError(`Skill ZIP cannot contain symlinks: ${normalizedPath}`);
  if (unixType !== 0 && unixType !== 0o040000 && unixType !== 0o100000) {
    throw new BadRequestError(`Skill ZIP cannot contain special files: ${normalizedPath}`);
  }
  const directory = entry.fileName.endsWith("/");
  if (unixType === 0o040000 && !directory) {
    throw new BadRequestError(`Skill ZIP directory entry must end with '/': ${normalizedPath}`);
  }
  if (unixType === 0o100000 && directory) {
    throw new BadRequestError(`Skill ZIP regular file entry cannot end with '/': ${normalizedPath}`);
  }
  return directory || unixType === 0o040000 ? "directory" : "file";
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error("Unable to open ZIP"));
      else resolve(zipFile);
    });
  });
}

function forEachEntry(zipFile: ZipFile, visit: (entry: Entry) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    zipFile.once("error", fail);
    zipFile.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipFile.on("entry", (entry) => {
      void visit(entry).then(
        () => zipFile.readEntry(),
        (error) => {
          zipFile.close();
          fail(error);
        },
      );
    });
    zipFile.readEntry();
  });
}

function readEntry(zipFile: ZipFile, entry: Entry, captureLimit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      let measured = 0;
      stream.on("data", (chunk: Buffer | Uint8Array) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        measured += bytes.byteLength;
        if (captureLimit > 0) chunks.push(bytes);
        if (measured > entry.uncompressedSize || (captureLimit > 0 && measured > captureLimit)) {
          stream.destroy(new BadRequestError(`Skill ZIP entry size is invalid: ${entry.fileName}`));
        }
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(captureLimit > 0 ? Buffer.concat(chunks) : Buffer.alloc(0)));
    });
  });
}

export function buildLegacySkillBundle(payload: SkillResourcePayload): Buffer {
  const metadata = JSON.stringify(payload.metadata) ?? "{}";
  const markdown = [
    "---",
    `name: ${JSON.stringify(payload.name)}`,
    ...(payload.namespace ? [`namespace: ${JSON.stringify(payload.namespace)}`] : []),
    `description: ${JSON.stringify(payload.description)}`,
    `metadata: ${metadata}`,
    "---",
    "",
    payload.body,
    "",
  ].join("\n");
  return Buffer.from(zipSync({ "SKILL.md": strToU8(markdown) }, { level: 6 }));
}

/**
 * Convert legacy inline Skill resources into immutable ZIP attachments without
 * changing Resource ids or Agent bindings. One bounded batch runs per boot.
 */
export async function backfillSkillResourceBundles(
  db: Database,
  blobStore: AttachmentBlobStore,
  quota: AttachmentObjectQuota,
  batchSize = 50,
): Promise<{ migrated: number; skipped: number }> {
  const rows = await db
    .select({
      id: resources.id,
      organizationId: resources.organizationId,
      ownerAgentId: resources.ownerAgentId,
      createdBy: resources.createdBy,
      payload: resources.payload,
    })
    .from(resources)
    .where(and(eq(resources.type, "skill"), isNull(resources.bundleAttachmentId)))
    .limit(batchSize);
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    const parsed = skillResourcePayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    try {
      normalizeTeamSkillTargetSlug(parsed.data.name);
    } catch {
      skipped++;
      continue;
    }
    const body = buildLegacySkillBundle(parsed.data);
    let attachmentId: string | undefined;
    try {
      let uploaderId = row.ownerAgentId;
      if (!uploaderId) {
        const [creator] = await db
          .select({ agentId: members.agentId })
          .from(members)
          .where(and(eq(members.id, row.createdBy), eq(members.organizationId, row.organizationId)))
          .limit(1);
        uploaderId = creator?.agentId ?? null;
      }
      const attachment = await createAttachment(
        db,
        {
          organizationId: row.organizationId,
          mimeType: "application/zip",
          filename: `${parsed.data.name}.zip`,
          body,
          contentLength: body.byteLength,
          uploadedBy: uploaderId ?? "system:skill-resource-backfill",
        },
        quota,
      );
      attachmentId = attachment.id;
      const updated = await db
        .update(resources)
        .set({ bundleAttachmentId: attachment.id, updatedAt: new Date() })
        .where(and(eq(resources.id, row.id), isNull(resources.bundleAttachmentId)))
        .returning({ id: resources.id });
      if (updated.length === 0) {
        await deleteAttachmentIfUnreferenced(db, blobStore, attachment.id);
        skipped++;
      } else {
        migrated++;
      }
    } catch {
      if (attachmentId) await deleteAttachmentIfUnreferenced(db, blobStore, attachmentId).catch(() => undefined);
      skipped++;
    }
  }
  return { migrated, skipped };
}
