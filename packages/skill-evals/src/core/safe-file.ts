import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const OPEN_BENEATH_PYTHON = String.raw`
import os
import stat
import sys
import time

root = sys.argv[1]
max_bytes = int(sys.argv[2])
after_parents_opened = sys.argv[3]
resume_after_swap = sys.argv[4]
parts = sys.argv[5:]
opened = []

def fail(message):
    raise RuntimeError(message)

try:
    if not parts or any(part in ("", ".", "..") or "/" in part or "\\" in part for part in parts):
        fail("invalid trusted-root locator")

    base_flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        base_flags |= os.O_CLOEXEC
    directory_flags = base_flags | os.O_DIRECTORY

    current = os.open(root, directory_flags)
    opened.append(current)
    for part in parts[:-1]:
        current = os.open(part, directory_flags, dir_fd=current)
        opened.append(current)

    if after_parents_opened:
        marker = os.open(after_parents_opened, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(marker)
        deadline = time.monotonic() + 5.0
        while not os.path.exists(resume_after_swap):
            if time.monotonic() >= deadline:
                fail("timed out waiting for deterministic open-beneath test swap")
            time.sleep(0.005)

    descriptor = os.open(parts[-1], base_flags, dir_fd=current)
    opened.append(descriptor)
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        fail("final target is not a standalone regular file")
    if before.st_size > max_bytes:
        fail("final target exceeds the snapshot size limit")

    chunks = []
    remaining = before.st_size
    while remaining:
        chunk = os.read(descriptor, min(remaining, 1024 * 1024))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)

    after = os.fstat(descriptor)
    stable = (
        stat.S_ISREG(after.st_mode)
        and after.st_nlink == 1
        and after.st_dev == before.st_dev
        and after.st_ino == before.st_ino
        and after.st_mode == before.st_mode
        and after.st_size == before.st_size
        and after.st_mtime_ns == before.st_mtime_ns
        and after.st_ctime_ns == before.st_ctime_ns
        and remaining == 0
    )
    if not stable:
        fail("file changed while taking host snapshot")
    sys.stdout.buffer.write(b"".join(chunks))
except Exception as error:
    sys.stderr.write(f"{type(error).__name__}: {error}\n")
    sys.exit(1)
finally:
    for descriptor in reversed(opened):
        try:
            os.close(descriptor)
        except OSError:
            pass
`;

const ENTRY_EXISTS_BENEATH_PYTHON = String.raw`
import os
import sys

root = sys.argv[1]
parts = sys.argv[2:]
opened = []

def fail(message):
    raise RuntimeError(message)

try:
    if not parts or any(part in ("", ".", "..") or "/" in part or "\\" in part for part in parts):
        fail("invalid trusted-root locator")

    base_flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        base_flags |= os.O_CLOEXEC
    directory_flags = base_flags | os.O_DIRECTORY

    current = os.open(root, directory_flags)
    opened.append(current)
    for part in parts[:-1]:
        current = os.open(part, directory_flags, dir_fd=current)
        opened.append(current)

    os.stat(parts[-1], dir_fd=current, follow_symlinks=False)
except FileNotFoundError:
    sys.exit(3)
except Exception as error:
    sys.stderr.write(f"{type(error).__name__}: {error}\n")
    sys.exit(1)
finally:
    for descriptor in reversed(opened):
        try:
            os.close(descriptor)
        except OSError:
            pass
`;

export type OpenedRegularFile = {
  descriptor: number;
  path: string;
};

export type OpenBeneathTestSynchronization = {
  afterParentsOpenedPath: string;
  resumeAfterSwapPath: string;
};

function trustedLocatorParts(trustedRoot: string, path: string): { parts: readonly string[]; root: string } {
  const root = resolve(trustedRoot);
  const target = resolve(path);
  const locator = relative(root, target);
  if (locator === "" || isAbsolute(locator) || locator === ".." || locator.startsWith(`..${sep}`)) {
    throw new Error(`Refusing path outside trusted root: ${path}`);
  }

  const parts = locator.split(sep);
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("/") || part.includes("\\"))) {
    throw new Error(`Refusing invalid path beneath trusted root: ${path}`);
  }
  return { parts, root };
}

function readOpenedDescriptor(opened: OpenedRegularFile, maxBytes: number): Buffer {
  const before = fstatSync(opened.descriptor, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) {
    throw new Error(`Refusing non-standalone regular file: ${opened.path}`);
  }
  if (before.size > BigInt(maxBytes)) {
    throw new Error(`Refusing oversized file: ${opened.path}`);
  }

  const buffer = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(opened.descriptor, buffer, offset, buffer.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }

  const after = fstatSync(opened.descriptor, { bigint: true });
  if (
    !after.isFile() ||
    after.nlink !== 1n ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    offset !== buffer.length
  ) {
    throw new Error(`File changed while taking host snapshot: ${opened.path}`);
  }
  return buffer;
}

export function openNoFollowRegularFile(path: string): OpenedRegularFile {
  return {
    descriptor: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    path,
  };
}

export function closeOpenedRegularFile(opened: OpenedRegularFile): void {
  closeSync(opened.descriptor);
}

export function readOpenedRegularFile(opened: OpenedRegularFile, maxBytes = DEFAULT_MAX_BYTES): Buffer {
  return readOpenedDescriptor(opened, maxBytes);
}

export function readOpenedRegularText(opened: OpenedRegularFile, maxBytes = DEFAULT_MAX_BYTES): string {
  return readOpenedRegularFile(opened, maxBytes).toString("utf8");
}

export function readNoFollowRegularFile(path: string, maxBytes = DEFAULT_MAX_BYTES): Buffer {
  const opened = openNoFollowRegularFile(path);
  try {
    return readOpenedRegularFile(opened, maxBytes);
  } finally {
    closeOpenedRegularFile(opened);
  }
}

export function readNoFollowRegularFileBeneath(
  trustedRoot: string,
  path: string,
  maxBytes = DEFAULT_MAX_BYTES,
  testSynchronization?: OpenBeneathTestSynchronization,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid snapshot size limit: ${String(maxBytes)}`);
  }
  const { parts, root } = trustedLocatorParts(trustedRoot, path);
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      OPEN_BENEATH_PYTHON,
      root,
      String(maxBytes),
      testSynchronization?.afterParentsOpenedPath ?? "",
      testSynchronization?.resumeAfterSwapPath ?? "",
      ...parts,
    ],
    {
      encoding: "buffer",
      maxBuffer: maxBytes + 64 * 1024,
    },
  );
  if (result.error) {
    throw new Error(`Trusted-root file reader could not start: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(`Trusted-root open rejected ${path}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

export function entryExistsNoFollowBeneath(trustedRoot: string, path: string): boolean {
  const { parts, root } = trustedLocatorParts(trustedRoot, path);
  const result = spawnSync("python3", ["-I", "-c", ENTRY_EXISTS_BENEATH_PYTHON, root, ...parts], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  if (result.error) {
    throw new Error(`Trusted-root entry check could not start: ${result.error.message}`, { cause: result.error });
  }
  if (result.status === 0) return true;
  if (result.status === 3) return false;
  const detail = result.stderr.trim();
  throw new Error(`Trusted-root entry check rejected ${path}${detail ? `: ${detail}` : ""}`);
}

export function readNoFollowRegularText(path: string, maxBytes = DEFAULT_MAX_BYTES): string {
  return readNoFollowRegularFile(path, maxBytes).toString("utf8");
}

export function readNoFollowRegularTextBeneath(
  trustedRoot: string,
  path: string,
  maxBytes = DEFAULT_MAX_BYTES,
  testSynchronization?: OpenBeneathTestSynchronization,
): string {
  return readNoFollowRegularFileBeneath(trustedRoot, path, maxBytes, testSynchronization).toString("utf8");
}
