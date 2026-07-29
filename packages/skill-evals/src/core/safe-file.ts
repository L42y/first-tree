import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export function readNoFollowRegularFile(path: string, maxBytes = DEFAULT_MAX_BYTES): Buffer {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error(`Refusing non-standalone regular file: ${path}`);
    }
    if (before.size > BigInt(maxBytes)) {
      throw new Error(`Refusing oversized file: ${path}`);
    }

    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }

    const after = fstatSync(descriptor, { bigint: true });
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
      throw new Error(`File changed while taking host snapshot: ${path}`);
    }
    return buffer;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function readNoFollowRegularText(path: string, maxBytes = DEFAULT_MAX_BYTES): string {
  return readNoFollowRegularFile(path, maxBytes).toString("utf8");
}
