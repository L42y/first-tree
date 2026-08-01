#!/usr/bin/env node
/**
 * Registry-safe npm tarball checks shared by release-pack smoke and unit tests.
 *
 * The npm registry rejects pack payloads whose entry names escape `package/`
 * (E415 Unsupported Media Type / "invalid path"). pnpm symlink layouts produce
 * exactly those names when `bundleDependencies` are packed without materializing
 * real in-package copies first.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * @typedef {{ name: string, typeFlag: string, linkname?: string }} TarEntry
 */

/**
 * List entries from a `.tgz` (gzip+ustar) using only Node builtins.
 * @param {string} tarballPath
 * @returns {TarEntry[]}
 */
export function listNpmTarballEntries(tarballPath) {
  const buf = gunzipSync(readFileSync(tarballPath));
  /** @type {TarEntry[]} */
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const size = Number.parseInt(readTarString(header, 124, 12) || "0", 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`invalid tar size field at offset ${offset}`);
    }
    const typeFlag = String.fromCharCode(header[156] || 0) || "0";
    const linkname = readTarString(header, 157, 100);
    const magic = readTarString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? readTarString(header, 345, 155) : "";
    const fullName = prefix ? `${prefix}/${name}` : name;
    entries.push({
      name: fullName,
      typeFlag,
      ...(linkname ? { linkname } : {}),
    });

    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * @param {Uint8Array} header
 * @param {number} start
 * @param {number} length
 */
function readTarString(header, start, length) {
  return Buffer.from(header.subarray(start, start + length))
    .toString("utf8")
    .replace(/\0.*$/s, "")
    .trim();
}

/**
 * Return human-readable violations for registry-unsafe entry names / link targets.
 * @param {TarEntry[]} entries
 * @returns {string[]}
 */
export function findUnsafeNpmTarballEntries(entries) {
  /** @type {string[]} */
  const violations = [];
  for (const entry of entries) {
    // npm pack payloads must place every member under the canonical `package/`
    // root (or the bare `package` directory entry). Rootless names like
    // `outside.txt` are registry-unsafe even without `..` traversal.
    if (entry.name !== "package" && !entry.name.startsWith("package/")) {
      violations.push(`missing package/ root: ${entry.name}`);
      continue;
    }
    const rel = entry.name === "package" ? "" : entry.name.slice("package/".length);
    const parts = rel === "" ? [] : rel.split("/");
    if (parts.includes("..")) {
      violations.push(`traversal path: ${entry.name}`);
      continue;
    }
    if (rel.startsWith("/") || entry.name.startsWith("/")) {
      violations.push(`absolute path: ${entry.name}`);
      continue;
    }
    if (entry.typeFlag === "2" || entry.typeFlag === "1") {
      const target = entry.linkname ?? "";
      const targetParts = target.split("/");
      if (target.startsWith("/") || targetParts.includes("..") || target.includes("node_modules/.pnpm/")) {
        violations.push(`escaping ${entry.typeFlag === "2" ? "symlink" : "hardlink"}: ${entry.name} -> ${target}`);
      }
    }
  }
  return violations;
}

/**
 * @param {string} tarballPath
 */
export function assertNpmTarballRegistrySafe(tarballPath) {
  const entries = listNpmTarballEntries(tarballPath);
  if (entries.length === 0) {
    throw new Error(`tarball has no entries: ${tarballPath}`);
  }
  const violations = findUnsafeNpmTarballEntries(entries);
  if (violations.length > 0) {
    const preview = violations.slice(0, 8).join("\n");
    const more = violations.length > 8 ? `\n... and ${violations.length - 8} more` : "";
    throw new Error(`npm tarball is not registry-safe (${violations.length} violation(s)):\n${preview}${more}`);
  }
  return { entryCount: entries.length };
}

/**
 * Build a tiny `.tgz` for unit tests (ustar + gzip). Not a general-purpose packer.
 * @param {string} outPath
 * @param {{ name: string, content?: string, typeFlag?: string, linkname?: string }[]} files
 */
export function writeSyntheticNpmTarball(outPath, files) {
  /** @type {Buffer[]} */
  const chunks = [];
  for (const file of files) {
    const content = Buffer.from(file.content ?? "", "utf8");
    const typeFlag = file.typeFlag ?? (file.linkname ? "2" : "0");
    chunks.push(buildUstarHeader(file.name, content.length, typeFlag, file.linkname ?? ""));
    if (typeFlag === "0" || typeFlag === "\0") {
      chunks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));
  writeFileSync(outPath, gzipSync(Buffer.concat(chunks)));
}

/**
 * @param {string} name
 * @param {number} size
 * @param {string} typeFlag
 * @param {string} linkname
 */
function buildUstarHeader(name, size, typeFlag, linkname) {
  const header = Buffer.alloc(512);
  writeTarField(header, 0, 100, name);
  writeTarField(header, 100, 8, "0000644");
  writeTarField(header, 108, 8, "0000000");
  writeTarField(header, 116, 8, "0000000");
  writeTarField(header, 124, 12, size.toString(8).padStart(11, "0"));
  writeTarField(
    header,
    136,
    12,
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0"),
  );
  header[156] = typeFlag.charCodeAt(0);
  writeTarField(header, 157, 100, linkname);
  writeTarField(header, 257, 6, "ustar");
  writeTarField(header, 263, 2, "00");
  // checksum: sum of header bytes with checksum field as spaces
  writeTarField(header, 148, 8, "        ");
  let sum = 0;
  for (const byte of header) sum += byte;
  writeTarField(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/**
 * @param {Buffer} header
 * @param {number} start
 * @param {number} length
 * @param {string} value
 */
function writeTarField(header, start, length, value) {
  const buf = Buffer.alloc(length);
  Buffer.from(value, "utf8").copy(buf);
  buf.copy(header, start);
}

function runSelftest() {
  const dir = mkdtempSync(pathJoin(tmpdir(), "npm-tarball-safety-selftest-"));
  try {
    const safePath = pathJoin(dir, "safe.tgz");
    writeSyntheticNpmTarball(safePath, [
      { name: "package/package.json", content: '{"name":"demo"}' },
      {
        name: "package/node_modules/@botiverse/kimi-code-sdk/package.json",
        content: '{"name":"@botiverse/kimi-code-sdk"}',
      },
    ]);
    assertNpmTarballRegistrySafe(safePath);

    const badPath = pathJoin(dir, "bad.tgz");
    // Mirrors the registry-rejected layout from staging publish run 30703432848.
    writeSyntheticNpmTarball(badPath, [
      {
        name: "package/../../node_modules/.pnpm/@botiverse+kimi-code-sdk@0.26.0/node_modules/@antfu/utils/LICENSE",
        content: "license",
      },
    ]);
    const violations = findUnsafeNpmTarballEntries(listNpmTarballEntries(badPath));
    if (!violations.some((line) => line.includes("traversal path"))) {
      throw new Error("expected traversal violation for synthetic pnpm layout");
    }
    let rejected = false;
    try {
      assertNpmTarballRegistrySafe(badPath);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("expected registry-safe assertion to reject traversal tarball");

    const rootlessPath = pathJoin(dir, "rootless.tgz");
    writeSyntheticNpmTarball(rootlessPath, [{ name: "outside.txt", content: "x" }]);
    const rootlessViolations = findUnsafeNpmTarballEntries(listNpmTarballEntries(rootlessPath));
    if (!rootlessViolations.some((line) => line.includes("missing package/ root"))) {
      throw new Error("expected missing package/ root violation for rootless entry");
    }
    let rootlessRejected = false;
    try {
      assertNpmTarballRegistrySafe(rootlessPath);
    } catch {
      rootlessRejected = true;
    }
    if (!rootlessRejected) {
      throw new Error("expected registry-safe assertion to reject rootless entry");
    }

    console.log("npm-tarball-safety: selftest PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(pathResolve(process.argv[1])).href) {
  runSelftest();
}
