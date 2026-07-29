import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export type OpenedRegularFile = {
  descriptor: number;
  path: string;
};

type FileIdentity = {
  ctimeNs: bigint;
  device: bigint;
  inode: bigint;
  mode: bigint;
  mtimeNs: bigint;
};

function identity(path: string, expectDirectory: boolean): FileIdentity {
  const value = lstatSync(path, { bigint: true });
  if (value.isSymbolicLink() || (expectDirectory ? !value.isDirectory() : !value.isFile())) {
    throw new Error(`Refusing unsafe path component: ${path}`);
  }
  return {
    ctimeNs: value.ctimeNs,
    device: value.dev,
    inode: value.ino,
    mode: value.mode,
    mtimeNs: value.mtimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function checkedAncestorIdentities(trustedRoot: string, path: string): ReadonlyMap<string, FileIdentity> {
  const root = resolve(trustedRoot);
  const target = resolve(path);
  const locator = relative(root, target);
  if (locator === "" || isAbsolute(locator) || locator === ".." || locator.startsWith(`..${sep}`)) {
    throw new Error(`Refusing path outside trusted root: ${path}`);
  }

  const checked = new Map<string, FileIdentity>();
  checked.set(root, identity(root, true));
  const parts = locator.split(sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    checked.set(current, identity(current, true));
  }
  return checked;
}

function verifyAncestorIdentities(checked: ReadonlyMap<string, FileIdentity>): void {
  for (const [path, expected] of checked) {
    if (!sameIdentity(expected, identity(path, true))) {
      throw new Error(`Path component changed while taking host snapshot: ${path}`);
    }
  }
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
): Buffer {
  const ancestors = checkedAncestorIdentities(trustedRoot, path);
  const opened = openNoFollowRegularFile(path);
  try {
    const openedIdentity = fstatSync(opened.descriptor, { bigint: true });
    const pathIdentity = identity(path, false);
    if (
      openedIdentity.dev !== pathIdentity.device ||
      openedIdentity.ino !== pathIdentity.inode ||
      openedIdentity.mode !== pathIdentity.mode
    ) {
      throw new Error(`File identity changed while opening beneath trusted root: ${path}`);
    }
    const contents = readOpenedRegularFile(opened, maxBytes);
    verifyAncestorIdentities(ancestors);
    return contents;
  } finally {
    closeOpenedRegularFile(opened);
  }
}

export function readNoFollowRegularText(path: string, maxBytes = DEFAULT_MAX_BYTES): string {
  return readNoFollowRegularFile(path, maxBytes).toString("utf8");
}

export function readNoFollowRegularTextBeneath(
  trustedRoot: string,
  path: string,
  maxBytes = DEFAULT_MAX_BYTES,
): string {
  return readNoFollowRegularFileBeneath(trustedRoot, path, maxBytes).toString("utf8");
}
