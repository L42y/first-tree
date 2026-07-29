import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  isTeamSkillOwnershipMarkerPath,
  parseTeamSkillBundleEntryPath,
  parseTeamSkillMarkdown,
  SKILL_NAME_REGEX,
  type SkillResourcePayload,
  skillResourcePayloadSchema,
  TEAM_SKILL_BUNDLE_LIMITS,
  TEAM_SKILL_OWNERSHIP_MARKER,
  TEAM_SKILL_RUNTIME_NAME_MAX,
  teamSkillBundleCollisionKey,
  teamSkillBundleTopologyConflict,
} from "@first-tree/shared";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { Database } from "../db/connection.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { resources } from "../db/schema/resources.js";
import { BadRequestError } from "../errors.js";
import {
  createAttachment,
  deleteAttachmentIfUnreferenced,
  loadAttachmentMeta,
  openAttachmentStream,
} from "./attachment.js";
import type { AttachmentBlobStore } from "./attachment-blob-store.js";

const RESERVED_SKILL_NAMES = new Set([
  "first-tree-welcome",
  "first-tree-seed",
  "first-tree-file-bug",
  "first-tree-qa",
  "first-tree-read",
  "first-tree-write",
  "context-tree-review",
  "context-tree-audit",
]);

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
  if (meta.sizeBytes > TEAM_SKILL_BUNDLE_LIMITS.compressedBytes) {
    throw new BadRequestError(`Skill ZIP exceeds ${TEAM_SKILL_BUNDLE_LIMITS.compressedBytes} compressed bytes`);
  }
  const stream = await openAttachmentStream(db, blobStore, attachmentId);
  if (!stream) throw new BadRequestError("Skill bundle attachment bytes are unavailable");

  const tempDir = await mkdtemp(join(tmpdir(), "first-tree-skill-"));
  const zipPath = join(tempDir, "bundle.zip");
  try {
    let measuredCompressedBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        measuredCompressedBytes += chunk.byteLength;
        if (measuredCompressedBytes > TEAM_SKILL_BUNDLE_LIMITS.compressedBytes) {
          callback(
            new BadRequestError(`Skill ZIP exceeds ${TEAM_SKILL_BUNDLE_LIMITS.compressedBytes} compressed bytes`),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(stream, limiter, createWriteStream(zipPath, { flags: "wx" }));
    if (measuredCompressedBytes !== meta.sizeBytes) {
      throw new BadRequestError("Skill ZIP stored size does not match its attachment metadata");
    }
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
  const pathTypes: Array<{ path: string; directory: boolean }> = [];
  const files: string[] = [];
  const skillMarkdown = new Map<string, Buffer>();
  let totalUncompressed = 0;
  let entryCount = 0;

  try {
    await forEachEntry(zipFile, async (entry) => {
      entryCount++;
      if (entryCount > TEAM_SKILL_BUNDLE_LIMITS.entries) {
        throw new BadRequestError(`Skill ZIP cannot contain more than ${TEAM_SKILL_BUNDLE_LIMITS.entries} entries`);
      }
      const parsedPath = parseTeamSkillBundleEntryPath(entry.fileName);
      if (!parsedPath) throw new BadRequestError(`Skill ZIP contains an unsafe path: ${entry.fileName}`);
      const normalized = parsedPath.normalized;
      const collisionKey = teamSkillBundleCollisionKey(normalized);
      if (seenPaths.has(collisionKey)) {
        throw new BadRequestError(`Skill ZIP contains a duplicate path: ${normalized}`);
      }
      seenPaths.add(collisionKey);
      pathTypes.push({ path: normalized, directory: parsedPath.directory });
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        throw new BadRequestError(`Skill ZIP contains an encrypted entry: ${normalized}`);
      }
      validateEntryType(entry, parsedPath.directory, normalized);
      if (parsedPath.directory) {
        if (entry.uncompressedSize !== 0) {
          throw new BadRequestError(`Skill ZIP directory has non-zero content: ${normalized}`);
        }
        return;
      }

      files.push(normalized);
      if (files.length > TEAM_SKILL_BUNDLE_LIMITS.files) {
        throw new BadRequestError(`Skill ZIP cannot contain more than ${TEAM_SKILL_BUNDLE_LIMITS.files} files`);
      }
      if (entry.uncompressedSize > TEAM_SKILL_BUNDLE_LIMITS.fileBytes) {
        throw new BadRequestError(`Skill ZIP entry exceeds ${TEAM_SKILL_BUNDLE_LIMITS.fileBytes} bytes: ${normalized}`);
      }
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > TEAM_SKILL_BUNDLE_LIMITS.totalBytes) {
        throw new BadRequestError(`Skill ZIP exceeds ${TEAM_SKILL_BUNDLE_LIMITS.totalBytes} uncompressed bytes`);
      }

      const isSkillMarkdown = parsedPath.segments.at(-1) === "SKILL.md";
      if (isSkillMarkdown && entry.uncompressedSize > TEAM_SKILL_BUNDLE_LIMITS.skillMarkdownBytes) {
        throw new BadRequestError(`SKILL.md exceeds ${TEAM_SKILL_BUNDLE_LIMITS.skillMarkdownBytes} bytes`);
      }
      const bytes = await readEntry(zipFile, entry, isSkillMarkdown ? TEAM_SKILL_BUNDLE_LIMITS.skillMarkdownBytes : 0);
      if (isSkillMarkdown) skillMarkdown.set(normalized, bytes);
    });
  } finally {
    zipFile.close();
  }

  const topologyConflict = teamSkillBundleTopologyConflict(pathTypes);
  if (topologyConflict) {
    throw new BadRequestError(
      `Skill ZIP path ${topologyConflict.path} is nested below file ${topologyConflict.fileParent}`,
    );
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
  const rootPrefix = segments.length === 2 ? `${segments[0]}/` : "";
  const rootName = segments.length === 2 ? segments[0] : null;
  if (
    rootPrefix &&
    pathTypes.some(({ path: entryPath }) => entryPath !== rootName && !entryPath.startsWith(rootPrefix))
  ) {
    throw new BadRequestError("A wrapped Skill ZIP cannot contain entries outside its top-level directory");
  }
  const strippedPaths = pathTypes.flatMap(({ path: entryPath }) => {
    const stripped = rootPrefix ? (entryPath === rootName ? "" : entryPath.slice(rootPrefix.length)) : entryPath;
    return stripped ? [stripped] : [];
  });
  if (strippedPaths.some(isTeamSkillOwnershipMarkerPath)) {
    throw new BadRequestError(`Skill ZIP may not provide reserved file ${TEAM_SKILL_OWNERSHIP_MARKER}`);
  }

  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequestError("SKILL.md must be valid UTF-8");
  }
  let parsed: ReturnType<typeof parseTeamSkillMarkdown>;
  try {
    parsed = parseTeamSkillMarkdown(markdown);
  } catch (error) {
    throw new BadRequestError(`SKILL.md frontmatter is invalid: ${error instanceof Error ? error.message : error}`);
  }
  const frontmatter =
    parsed.frontmatter && typeof parsed.frontmatter === "object" && !Array.isArray(parsed.frontmatter)
      ? (parsed.frontmatter as Record<string, unknown>)
      : {};
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  const namespace = typeof frontmatter.namespace === "string" ? frontmatter.namespace.trim() : undefined;
  if (!name || name.length > TEAM_SKILL_RUNTIME_NAME_MAX || !SKILL_NAME_REGEX.test(name)) {
    throw new BadRequestError("SKILL.md name must start with an alphanumeric and contain only letters, digits, _ or -");
  }
  if (RESERVED_SKILL_NAMES.has(name.toLocaleLowerCase("en-US"))) {
    throw new BadRequestError(`Skill name "${name}" is reserved by First Tree`);
  }
  if (!description || description.length > 1_000) {
    throw new BadRequestError("SKILL.md description is required and must be at most 1000 characters");
  }
  if (namespace && (namespace.length > 100 || !SKILL_NAME_REGEX.test(namespace))) {
    throw new BadRequestError("SKILL.md namespace must contain only letters, digits, _ or -");
  }
  const rawMetadata = frontmatter.metadata;
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

function validateEntryType(entry: Entry, directory: boolean, path: string): void {
  const madeByUnix = entry.versionMadeBy >>> 8 === 3;
  if (!madeByUnix) return;
  const mode = entry.externalFileAttributes >>> 16;
  const type = mode & 0o170000;
  if (type === 0) return;
  if (type === 0o120000) throw new BadRequestError(`Skill ZIP cannot contain symlinks: ${path}`);
  const expected = directory ? 0o040000 : 0o100000;
  if (type !== expected) throw new BadRequestError(`Skill ZIP cannot contain special files: ${path}`);
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
      stream.once("end", () => {
        if (measured !== entry.uncompressedSize) {
          reject(new BadRequestError(`Skill ZIP entry size is invalid: ${entry.fileName}`));
          return;
        }
        resolve(captureLimit > 0 ? Buffer.concat(chunks) : Buffer.alloc(0));
      });
    });
  });
}

export function buildLegacySkillBundle(payload: SkillResourcePayload): Buffer {
  const metadata = JSON.stringify(payload.metadata) ?? "{}";
  const markdown = strToU8(
    [
      "---",
      `name: ${JSON.stringify(payload.name)}`,
      ...(payload.namespace ? [`namespace: ${JSON.stringify(payload.namespace)}`] : []),
      `description: ${JSON.stringify(payload.description)}`,
      `metadata: ${metadata}`,
      "---",
      "",
      payload.body,
      "",
    ].join("\n"),
  );
  if (markdown.byteLength > TEAM_SKILL_BUNDLE_LIMITS.skillMarkdownBytes) {
    throw new BadRequestError(
      `Legacy Skill cannot be bundled because SKILL.md exceeds ${TEAM_SKILL_BUNDLE_LIMITS.skillMarkdownBytes} bytes`,
    );
  }
  const bundle = Buffer.from(zipSync({ "SKILL.md": markdown }, { level: 6 }));
  if (bundle.byteLength > TEAM_SKILL_BUNDLE_LIMITS.compressedBytes) {
    throw new BadRequestError(
      `Legacy Skill cannot be bundled because its ZIP exceeds ${TEAM_SKILL_BUNDLE_LIMITS.compressedBytes} bytes`,
    );
  }
  return bundle;
}

/**
 * Convert legacy inline Skill resources into immutable ZIP attachments without
 * changing Resource ids or Agent bindings. One bounded batch runs per boot.
 */
export async function backfillSkillResourceBundles(
  db: Database,
  blobStore: AttachmentBlobStore,
  options: Readonly<{
    batchSize?: number;
    notifyAgent?: (agentId: string) => Promise<void>;
  }> = {},
): Promise<{ migrated: number; skipped: number; affectedAgentCount: number }> {
  const batchSize = options.batchSize ?? 50;
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
  const affectedAgentIds = new Set<string>();
  for (const row of rows) {
    const parsed = skillResourcePayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    let attachmentId: string | undefined;
    try {
      const body = buildLegacySkillBundle(parsed.data);
      let uploaderId = row.ownerAgentId;
      if (!uploaderId) {
        const [creator] = await db
          .select({ agentId: members.agentId })
          .from(members)
          .where(and(eq(members.id, row.createdBy), eq(members.organizationId, row.organizationId)))
          .limit(1);
        uploaderId = creator?.agentId ?? null;
      }
      const attachment = await createAttachment(db, {
        organizationId: row.organizationId,
        mimeType: "application/zip",
        filename: `${parsed.data.name}.zip`,
        body,
        contentLength: body.byteLength,
        uploadedBy: uploaderId ?? "system:skill-resource-backfill",
      });
      attachmentId = attachment.id;
      const updated = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(resources)
          .set({ bundleAttachmentId: attachment.id, updatedAt: new Date() })
          .where(and(eq(resources.id, row.id), isNull(resources.bundleAttachmentId)))
          .returning({ id: resources.id });
        if (claimed.length === 0) return { claimed: false as const, agentIds: [] };
        const runtimeAgents = await tx
          .select({ agentId: agents.uuid })
          .from(agents)
          .where(
            and(eq(agents.organizationId, row.organizationId), ne(agents.status, "deleted"), ne(agents.type, "human")),
          );
        const agentIds = runtimeAgents.map(({ agentId }) => agentId);
        if (agentIds.length > 0) {
          await tx
            .update(agentConfigs)
            .set({
              version: sql`${agentConfigs.version} + 1`,
              updatedAt: new Date(),
              updatedBy: row.createdBy,
            })
            .where(inArray(agentConfigs.agentId, agentIds));
        }
        return { claimed: true as const, agentIds };
      });
      if (!updated.claimed) {
        await deleteAttachmentIfUnreferenced(db, blobStore, attachment.id);
        skipped++;
      } else {
        migrated++;
        for (const agentId of updated.agentIds) affectedAgentIds.add(agentId);
      }
    } catch {
      if (attachmentId) await deleteAttachmentIfUnreferenced(db, blobStore, attachmentId).catch(() => undefined);
      skipped++;
    }
  }
  const notifyAgent = options.notifyAgent;
  if (notifyAgent) {
    await Promise.allSettled(Array.from(affectedAgentIds, (agentId) => notifyAgent(agentId)));
  }
  return { migrated, skipped, affectedAgentCount: affectedAgentIds.size };
}
