import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { channelConfig } from "./channel.js";

export type PortableInstallContext = {
  /** Stable `<prefix>/current` symlink. Never realpath this value. */
  root: string;
  prefix: string;
  /** Authoritative directory containing the channel shims. */
  binDir: string;
  /** Stable outer channel shim used by services and managed refresh. */
  cliPath: string;
  /** Stable bundled-Node directory used in supervisor PATH. */
  nodeBinDir: string;
};

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Render the stable outer shim contract shared by installer and self-update. */
export function portableShimContents(root: string, binDir: string): string {
  return `#!/bin/sh
set -eu
root=${shellSingleQuote(root)}
bin_dir=${shellSingleQuote(binDir)}
export FIRST_TREE_INSTALL_MODE=portable
export FIRST_TREE_PORTABLE_ROOT="$root"
export FIRST_TREE_PORTABLE_BIN_DIR="$bin_dir"
exec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"
`;
}

function portableRepairError(detail: string): Error {
  return new Error(
    `${detail} Rerun the ${channelConfig.channel} portable installer to repair the stable shim and service unit.`,
  );
}

function assertExecutable(path: string): void {
  if (!existsSync(path)) throw portableRepairError(`Portable CLI shim does not exist: ${path}.`);
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch {
    throw portableRepairError(`Portable CLI shim is not readable and executable: ${path}.`);
  }
}

function isLegacyDefaultShimForRoot(path: string, root: string): boolean {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const escapedRoot = root.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (
    body.includes(`root="${escapedRoot}"`) &&
    body.includes("export FIRST_TREE_INSTALL_MODE=portable") &&
    body.includes('export FIRST_TREE_PORTABLE_ROOT="$root"') &&
    body.includes('exec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"')
  );
}

function assertShimIdentity(path: string, root: string, binDir: string, allowLegacyDefault: boolean): void {
  assertExecutable(path);
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    throw portableRepairError(`Cannot read portable CLI shim: ${path}.`);
  }
  if (body === portableShimContents(root, binDir)) return;
  if (allowLegacyDefault && isLegacyDefaultShimForRoot(path, root)) return;
  throw portableRepairError(
    `Portable CLI shim ${path} does not identify the same portable root and channel as ${root}.`,
  );
}

/**
 * Resolve authoritative portable installation identity without consulting PATH.
 *
 * Old shims did not export a bin directory. For those, only the documented
 * default `~/.local/bin` is accepted, and only when its channel shim can be
 * verified against the same stable `current` root. Custom legacy installs are
 * deliberately ambiguous and must be repaired by rerunning the installer.
 */
export function resolvePortableInstallContext(): PortableInstallContext | null {
  const mode = process.env.FIRST_TREE_INSTALL_MODE?.trim();
  const rootSignal = process.env.FIRST_TREE_PORTABLE_ROOT?.trim();
  if (mode !== "portable" && !rootSignal) return null;

  if (!rootSignal) {
    throw portableRepairError("FIRST_TREE_INSTALL_MODE=portable is missing FIRST_TREE_PORTABLE_ROOT.");
  }
  if (!isAbsolute(rootSignal)) {
    throw portableRepairError(`FIRST_TREE_PORTABLE_ROOT must be absolute, got ${JSON.stringify(rootSignal)}.`);
  }
  const root = resolve(rootSignal);
  if (basename(root) !== "current") {
    throw portableRepairError(`FIRST_TREE_PORTABLE_ROOT must name the stable current symlink, got ${root}.`);
  }
  const prefix = dirname(root);
  if (prefix === root) {
    throw portableRepairError(`Cannot derive a portable install prefix from ${root}.`);
  }

  const binSignal = process.env.FIRST_TREE_PORTABLE_BIN_DIR?.trim();
  const defaultBinDir = join(homedir(), ".local", "bin");
  const binDir = binSignal || defaultBinDir;
  if (!isAbsolute(binDir)) {
    throw portableRepairError(`FIRST_TREE_PORTABLE_BIN_DIR must be absolute, got ${JSON.stringify(binDir)}.`);
  }
  const normalizedBinDir = resolve(binDir);
  const cliPath = join(normalizedBinDir, channelConfig.binName);
  assertShimIdentity(cliPath, root, normalizedBinDir, !binSignal && normalizedBinDir === resolve(defaultBinDir));

  return {
    root,
    prefix,
    binDir: normalizedBinDir,
    cliPath,
    nodeBinDir: join(root, "node", "bin"),
  };
}

export function hasPortableInstallSignal(): boolean {
  return (
    process.env.FIRST_TREE_INSTALL_MODE?.trim() === "portable" || Boolean(process.env.FIRST_TREE_PORTABLE_ROOT?.trim())
  );
}
