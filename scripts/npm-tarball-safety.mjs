#!/usr/bin/env node
/**
 * Registry-safe npm tarball checks shared by release-pack smoke and unit tests.
 *
 * The npm registry rejects pack payloads whose entry names escape `package/`
 * (E415 Unsupported Media Type / "invalid path"). pnpm symlink layouts produce
 * exactly those names when `bundleDependencies` are packed without materializing
 * real in-package copies first.
 *
 * Invariant: every member name must be a POSIX-canonical path under `package/`
 * (or the bare `package` directory entry). Dot segments, empty segments,
 * backslashes, absolute paths, and link targets that resolve outside `package/`
 * are rejected. GNU/PAX long-name / extended headers are fail-closed because
 * this parser does not interpret them — silently skipping would under-enumerate.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * @typedef {{ name: string, typeFlag: string, linkname?: string }} TarEntry
 */

/** GNU long-name / PAX extended headers this parser does not interpret. */
const UNSUPPORTED_TYPE_FLAGS = new Set(["L", "K", "x", "g", "X"]);

/**
 * List entries from a `.tgz` (gzip+ustar) using only Node builtins.
 * Fail closed on GNU/PAX long-name / extended headers.
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
    if (UNSUPPORTED_TYPE_FLAGS.has(typeFlag)) {
      throw new Error(
        `unsupported tar typeflag '${typeFlag}' at offset ${offset} (GNU/PAX long-name or extended header); fail closed rather than under-enumerate`,
      );
    }
    const linkname = readTarString(header, 157, 100);
    const magic = readTarString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? readTarString(header, 345, 155) : "";
    // Preserve backslashes in the joined name so the safety classifier can reject
    // non-POSIX separators explicitly (rather than silently normalizing them).
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
 * Return null when `name` is not a POSIX-canonical path under `package/`.
 * @param {string} name
 * @returns {string | null} relative path under package/ ("" for the package dir itself)
 */
export function packageRelativeCanonicalPath(name) {
  if (name.includes("\0") || name.includes("\\")) return null;
  if (name.startsWith("/")) return null;
  if (name === "package") return "";
  if (!name.startsWith("package/")) return null;
  const rel = name.slice("package/".length);
  if (rel === "") return "";
  const parts = rel.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return null;
  }
  return rel;
}

/**
 * Resolve a tar link target relative to the entry's directory and prove the
 * result stays under `package/`. Returns the canonical package-relative path
 * or null when the link escapes / is non-canonical.
 * @param {string} entryName
 * @param {string} linkTarget
 */
export function resolveTarLinkWithinPackage(entryName, linkTarget) {
  if (!linkTarget || linkTarget.includes("\0") || linkTarget.includes("\\")) return null;
  if (linkTarget.startsWith("/")) return null;

  const entryRel = packageRelativeCanonicalPath(entryName);
  if (entryRel === null) return null;

  const entryDirParts = entryName === "package" ? ["package"] : entryName.split("/").slice(0, -1);
  const stack = [...entryDirParts];
  for (const part of linkTarget.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length <= 1) return null; // would leave package/
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack[0] !== "package") return null;
  const resolved = stack.join("/");
  return packageRelativeCanonicalPath(resolved) === null ? null : resolved;
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
    const rel = packageRelativeCanonicalPath(entry.name);
    if (rel === null) {
      if (entry.name.includes("\\") || entry.name.includes("\0")) {
        violations.push(`non-posix path separator: ${entry.name}`);
      } else if (!entry.name.startsWith("package/") && entry.name !== "package") {
        violations.push(`missing package/ root: ${entry.name}`);
      } else {
        violations.push(`non-canonical package path: ${entry.name}`);
      }
      continue;
    }
    if (entry.typeFlag === "2") {
      // Symlink targets are resolved relative to the link entry's directory.
      const target = entry.linkname ?? "";
      const resolved = resolveTarLinkWithinPackage(entry.name, target);
      if (resolved === null) {
        violations.push(`escaping symlink: ${entry.name} -> ${target}`);
      }
    } else if (entry.typeFlag === "1") {
      // Hardlink targets are archive-root paths, not directory-relative. Require
      // the linkname itself to be a canonical package/... member path so a
      // nested entry cannot smuggle `../outside` through relative resolution.
      const target = entry.linkname ?? "";
      if (packageRelativeCanonicalPath(target) === null) {
        violations.push(`escaping hardlink: ${entry.name} -> ${target}`);
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

function expectReject(label, files, needle) {
  const dir = mkdtempSync(pathJoin(tmpdir(), "npm-tarball-safety-case-"));
  try {
    const path = pathJoin(dir, "case.tgz");
    writeSyntheticNpmTarball(path, files);
    const violations = findUnsafeNpmTarballEntries(listNpmTarballEntries(path));
    if (!violations.some((line) => line.includes(needle))) {
      throw new Error(
        `${label}: expected violation containing ${JSON.stringify(needle)}, got ${JSON.stringify(violations)}`,
      );
    }
    let rejected = false;
    try {
      assertNpmTarballRegistrySafe(path);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`${label}: expected assertNpmTarballRegistrySafe to throw`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
      {
        name: "package/node_modules/@botiverse/kimi-code-sdk/dist/index.mjs",
        content: "export {}",
        typeFlag: "2",
        linkname: "./other.mjs",
      },
    ]);
    // Re-write safe tarball without the relative link that stays in-package —
    // keep a plain safe set for the happy path.
    writeSyntheticNpmTarball(safePath, [
      { name: "package/package.json", content: '{"name":"demo"}' },
      {
        name: "package/node_modules/@botiverse/kimi-code-sdk/package.json",
        content: '{"name":"@botiverse/kimi-code-sdk"}',
      },
    ]);
    assertNpmTarballRegistrySafe(safePath);

    expectReject(
      "pnpm traversal",
      [
        {
          name: "package/../../node_modules/.pnpm/@botiverse+kimi-code-sdk@0.26.0/node_modules/@antfu/utils/LICENSE",
          content: "license",
        },
      ],
      "non-canonical package path",
    );
    expectReject("rootless entry", [{ name: "outside.txt", content: "x" }], "missing package/ root");
    expectReject("dot segment", [{ name: "package/./inside.txt", content: "x" }], "non-canonical package path");
    expectReject(
      "backslash traversal",
      [{ name: "package\\..\\outside.txt", content: "x" }],
      "non-posix path separator",
    );
    expectReject("empty segment", [{ name: "package//inside.txt", content: "x" }], "non-canonical package path");
    expectReject(
      "escaping symlink",
      [
        {
          name: "package/node_modules/demo/link",
          typeFlag: "2",
          linkname: "../../../outside",
        },
      ],
      "escaping symlink",
    );
    // Hardlink targets are archive-root paths: `../outside` must NOT be accepted
    // via directory-relative resolution from a nested entry.
    expectReject(
      "escaping hardlink",
      [
        {
          name: "package/node_modules/demo/hard",
          typeFlag: "1",
          linkname: "../outside",
        },
      ],
      "escaping hardlink",
    );

    // In-package relative symlink must be accepted.
    const okLink = pathJoin(dir, "ok-link.tgz");
    writeSyntheticNpmTarball(okLink, [
      { name: "package/a/file.txt", content: "a" },
      { name: "package/a/link", typeFlag: "2", linkname: "./file.txt" },
    ]);
    assertNpmTarballRegistrySafe(okLink);

    // Canonical hardlink target under package/ must be accepted.
    const okHard = pathJoin(dir, "ok-hard.tgz");
    writeSyntheticNpmTarball(okHard, [
      { name: "package/a/file.txt", content: "a" },
      { name: "package/a/hard", typeFlag: "1", linkname: "package/a/file.txt" },
    ]);
    assertNpmTarballRegistrySafe(okHard);

    // GNU long-name typeflag must fail closed at parse time.
    const gnuPath = pathJoin(dir, "gnu.tgz");
    writeSyntheticNpmTarball(gnuPath, [{ name: "package/ignored", content: "", typeFlag: "L" }]);
    let gnuFailed = false;
    try {
      listNpmTarballEntries(gnuPath);
    } catch (error) {
      gnuFailed = error instanceof Error && error.message.includes("unsupported tar typeflag");
    }
    if (!gnuFailed) throw new Error("expected GNU long-name typeflag to fail closed");

    console.log("npm-tarball-safety: selftest PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(pathResolve(process.argv[1])).href) {
  runSelftest();
}
