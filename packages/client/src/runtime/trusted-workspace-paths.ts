import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

export function requireTrustedDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory and must not be a symlink: ${absolute}`);
  }
  const canonical = realpathSync(absolute);
  if (canonical !== absolute) {
    throw new Error(`${label} must not traverse a symlinked or aliased ancestor: ${absolute}`);
  }
  return canonical;
}

export function ensureTrustedWorkspaceRoot(path: string): string {
  const absolute = resolve(path);
  try {
    requireTrustedDirectory(absolute, "Agent workspace root");
    return absolute;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const missing: string[] = [];
  let existing = absolute;
  while (true) {
    try {
      requireTrustedDirectory(existing, "Agent workspace ancestor");
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const parent = dirname(existing);
    if (parent === existing) {
      throw new Error(`Agent workspace root has no trusted existing ancestor: ${absolute}`);
    }
    missing.unshift(basename(existing));
    existing = parent;
  }

  let parent = requireTrustedDirectory(existing, "Agent workspace ancestor");
  for (const name of missing) {
    const child = join(parent, name);
    try {
      mkdirSync(child, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const childReal = requireTrustedDirectory(child, "Agent workspace path component");
    if (dirname(childReal) !== parent) {
      throw new Error(`Agent workspace path component escaped its trusted parent: ${child}`);
    }
    parent = childReal;
  }
  return absolute;
}

export function ensureTrustedChildDirectory(parent: string, name: string, label: string): string {
  const parentReal = requireTrustedDirectory(parent, `${label} parent`);
  const child = join(parentReal, name);
  try {
    mkdirSync(child, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const childReal = requireTrustedDirectory(child, label);
  if (dirname(childReal) !== parentReal) {
    throw new Error(`${label} must be a direct child of its trusted parent: ${child}`);
  }
  return childReal;
}

/** Atomically replace the directory entry itself, never following an existing symlink. */
export function atomicWriteTrustedFile(path: string, content: string): void {
  const parent = requireTrustedDirectory(dirname(path), "Publication file parent");
  const destination = join(parent, basename(path));
  const tmp = join(parent, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(tmp, destination);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; surface the original publication failure.
    }
    throw error;
  }
}
