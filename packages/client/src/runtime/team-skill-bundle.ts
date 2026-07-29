import { createWriteStream } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  isTeamSkillOwnershipMarkerPath,
  parseTeamSkillBundleEntryPath,
  TEAM_SKILL_BUNDLE_LIMITS,
  TEAM_SKILL_OWNERSHIP_MARKER,
  type TeamSkillBundleEntryPath,
  teamSkillBundleCollisionKey,
  teamSkillBundleTopologyConflict,
} from "@first-tree/shared";
import yauzl, { type Entry, type ZipFile } from "yauzl";

type PlannedEntry = Readonly<{
  rawPath: string;
  parsedPath: TeamSkillBundleEntryPath;
  relativePath: string;
  directory: boolean;
  uncompressedSize: number;
  executableBits: number;
}>;

type InspectedEntry = Omit<PlannedEntry, "relativePath">;

export async function extractTeamSkillBundle(bytes: Buffer, destinationRoot: string): Promise<void> {
  if (bytes.byteLength > TEAM_SKILL_BUNDLE_LIMITS.compressedBytes) {
    throw new Error(`Skill ZIP exceeds ${TEAM_SKILL_BUNDLE_LIMITS.compressedBytes} compressed bytes`);
  }
  const plan = await inspectBundle(bytes);
  const planByRawPath = new Map(plan.map((entry) => [entry.rawPath, entry]));
  const zipFile = await openZip(bytes);
  let actualTotal = 0;
  try {
    await forEachEntry(zipFile, async (entry) => {
      const planned = planByRawPath.get(entry.fileName);
      if (!planned) throw new Error(`Skill ZIP entry changed during extraction: ${entry.fileName}`);
      if (planned.relativePath.length === 0) return;
      const destination = resolve(destinationRoot, ...planned.relativePath.split("/"));
      const root = resolve(destinationRoot);
      if (destination === root || !destination.startsWith(`${root}${sep}`)) {
        throw new Error(`Skill ZIP entry escapes staging: ${planned.relativePath}`);
      }
      if (planned.directory) {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        return;
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const stream = await openEntryStream(zipFile, entry);
      let measured = 0;
      stream.on("data", (chunk: Buffer | Uint8Array) => {
        measured += chunk.byteLength;
        if (
          measured > planned.uncompressedSize ||
          measured > TEAM_SKILL_BUNDLE_LIMITS.fileBytes ||
          actualTotal + measured > TEAM_SKILL_BUNDLE_LIMITS.totalBytes
        ) {
          stream.destroy(new Error(`Skill ZIP entry size is invalid: ${planned.relativePath}`));
        }
      });
      await pipeline(
        stream,
        createWriteStream(destination, {
          flags: "wx",
          mode: 0o600 | planned.executableBits,
        }),
      );
      if (measured !== planned.uncompressedSize) {
        throw new Error(`Skill ZIP entry size is invalid: ${planned.relativePath}`);
      }
      actualTotal += measured;
      await chmod(destination, 0o600 | planned.executableBits);
    });
  } finally {
    zipFile.close();
  }
}

async function inspectBundle(bytes: Buffer): Promise<readonly PlannedEntry[]> {
  const zipFile = await openZip(bytes);
  const entries: InspectedEntry[] = [];
  const seenRawPaths = new Set<string>();
  const skillMarkdownPaths: string[] = [];
  let files = 0;
  let declaredTotal = 0;
  try {
    await forEachEntry(zipFile, async (entry) => {
      if (entries.length >= TEAM_SKILL_BUNDLE_LIMITS.entries) {
        throw new Error(`Skill ZIP cannot contain more than ${TEAM_SKILL_BUNDLE_LIMITS.entries} entries`);
      }
      const parsedPath = parseTeamSkillBundleEntryPath(entry.fileName);
      if (!parsedPath) throw new Error(`Skill ZIP contains an unsafe path: ${entry.fileName}`);
      const collisionKey = teamSkillBundleCollisionKey(parsedPath.normalized);
      if (seenRawPaths.has(collisionKey)) {
        throw new Error(`Skill ZIP contains a duplicate or case-colliding path: ${parsedPath.normalized}`);
      }
      seenRawPaths.add(collisionKey);
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        throw new Error(`Skill ZIP contains an encrypted entry: ${parsedPath.normalized}`);
      }
      validateEntryType(entry, parsedPath.directory, parsedPath.normalized);
      if (parsedPath.directory) {
        if (entry.uncompressedSize !== 0) {
          throw new Error(`Skill ZIP directory has non-zero content: ${parsedPath.normalized}`);
        }
      } else {
        files++;
        if (files > TEAM_SKILL_BUNDLE_LIMITS.files) {
          throw new Error(`Skill ZIP cannot contain more than ${TEAM_SKILL_BUNDLE_LIMITS.files} files`);
        }
        if (entry.uncompressedSize > TEAM_SKILL_BUNDLE_LIMITS.fileBytes) {
          throw new Error(
            `Skill ZIP entry exceeds ${TEAM_SKILL_BUNDLE_LIMITS.fileBytes} bytes: ${parsedPath.normalized}`,
          );
        }
        declaredTotal += entry.uncompressedSize;
        if (declaredTotal > TEAM_SKILL_BUNDLE_LIMITS.totalBytes) {
          throw new Error(`Skill ZIP exceeds ${TEAM_SKILL_BUNDLE_LIMITS.totalBytes} uncompressed bytes`);
        }
        if (parsedPath.segments.at(-1) === "SKILL.md") {
          if (entry.uncompressedSize > TEAM_SKILL_BUNDLE_LIMITS.skillMarkdownBytes) {
            throw new Error(`SKILL.md exceeds ${TEAM_SKILL_BUNDLE_LIMITS.skillMarkdownBytes} bytes`);
          }
          skillMarkdownPaths.push(parsedPath.normalized);
        }
      }
      entries.push({
        rawPath: entry.fileName,
        parsedPath,
        directory: parsedPath.directory,
        uncompressedSize: entry.uncompressedSize,
        executableBits: unixExecutableBits(entry),
      });
    });
  } finally {
    zipFile.close();
  }

  const topologyConflict = teamSkillBundleTopologyConflict(
    entries.map((entry) => ({ path: entry.parsedPath.normalized, directory: entry.directory })),
  );
  if (topologyConflict) {
    throw new Error(`Skill ZIP path ${topologyConflict.path} is nested below file ${topologyConflict.fileParent}`);
  }
  if (skillMarkdownPaths.length !== 1) throw new Error("Skill ZIP must contain exactly one exact-case SKILL.md");
  const skillPath = skillMarkdownPaths[0];
  if (!skillPath) throw new Error("Skill ZIP must contain SKILL.md");
  const skillSegments = skillPath.split("/");
  if (skillSegments.length > 2 || skillSegments.at(-1) !== "SKILL.md") {
    throw new Error("SKILL.md must be at the ZIP root or inside one top-level directory");
  }
  const wrapper = skillSegments.length === 2 ? skillSegments[0] : null;
  if (
    wrapper &&
    entries.some(
      (entry) => entry.parsedPath.normalized !== wrapper && !entry.parsedPath.normalized.startsWith(`${wrapper}/`),
    )
  ) {
    throw new Error("A wrapped Skill ZIP cannot contain entries outside its top-level directory");
  }

  const planned: PlannedEntry[] = [];
  const seenRelativePaths = new Set<string>();
  for (const entry of entries) {
    const relativePath = wrapper
      ? entry.parsedPath.normalized === wrapper
        ? ""
        : entry.parsedPath.normalized.slice(wrapper.length + 1)
      : entry.parsedPath.normalized;
    if (!relativePath) {
      if (!entry.directory) throw new Error("Wrapped Skill root must be a directory");
      planned.push({ ...entry, relativePath });
      continue;
    }
    const collisionKey = teamSkillBundleCollisionKey(relativePath);
    if (seenRelativePaths.has(collisionKey)) {
      throw new Error(`Skill ZIP contains a case-colliding extracted path: ${relativePath}`);
    }
    seenRelativePaths.add(collisionKey);
    if (isTeamSkillOwnershipMarkerPath(relativePath)) {
      throw new Error(`Skill ZIP may not provide reserved file ${TEAM_SKILL_OWNERSHIP_MARKER}`);
    }
    planned.push({ ...entry, relativePath });
  }
  return planned;
}

function validateEntryType(entry: Entry, directory: boolean, path: string): void {
  const madeByUnix = entry.versionMadeBy >>> 8 === 3;
  if (!madeByUnix) return;
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (type === 0) return;
  if (type === 0o120000) throw new Error(`Skill ZIP cannot contain symlinks: ${path}`);
  const expected = directory ? 0o040000 : 0o100000;
  if (type !== expected) throw new Error(`Skill ZIP cannot contain special files: ${path}`);
}

function unixExecutableBits(entry: Entry): number {
  if (entry.versionMadeBy >>> 8 !== 3) return 0;
  return (entry.externalFileAttributes >>> 16) & 0o111;
}

function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || !zipFile) reject(error ?? new Error("Unable to open ZIP"));
        else resolvePromise(zipFile);
      },
    );
  });
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolvePromise, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`Unable to read ${entry.fileName}`));
      else resolvePromise(stream);
    });
  });
}

function forEachEntry(zipFile: ZipFile, visit: (entry: Entry) => Promise<void>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    zipFile.once("error", fail);
    zipFile.once("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise();
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
