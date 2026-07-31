import type { ChildProcess, SpawnOptions } from "node:child_process";
import { getChildProcessRegistry } from "./child-process-registry.js";

export type ProviderProcessSpec = {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  label: string;
  timeoutMs?: number;
};

export type SupervisedProviderProcess = {
  child: ChildProcess;
  /**
   * Runtime-local cleanup observation. This is diagnostic only and is never a
   * substitute for client-switch drain authority.
   */
  exited: Promise<void>;
};

export interface ProviderProcessSupervisor {
  spawn(spec: ProviderProcessSpec): SupervisedProviderProcess;
}

/**
 * Whether the built-in supervisor can safely execute an external provider on
 * this platform. Capability advertising uses the same gate as spawn so a
 * Windows client cannot offer a runtime that this supervisor will reject.
 */
export function supportsDefaultProviderProcessSupervision(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * The existing POSIX path: environment-attributed process-tree observation is
 * still the client-switch authority; the registry only improves local abort
 * and daemon shutdown cleanup.
 *
 * Windows deliberately fails closed here. OpenCode descendants must be
 * pre-admitted to a non-breakaway kill-on-close Job by a platform supervisor
 * before this factory can be enabled. Supplying that supervisor is an
 * explicit product seam, not a child-registry fallback.
 */
export function createDefaultProviderProcessSupervisor(
  platform: NodeJS.Platform = process.platform,
): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      if (!supportsDefaultProviderProcessSupervision(platform)) {
        throw new ProviderProcessSupervisionUnsupportedError(
          "OpenCode on Windows requires a pre-admission Job Object supervisor; " +
            "the current client-switch drain authority remains unsupported",
        );
      }
      const { child, record } = getChildProcessRegistry().spawn(spec.command, spec.args, {
        ...spec.options,
        category: "other",
        label: spec.label,
        ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
      });
      return { child, exited: record.exited };
    },
  };
}

export class ProviderProcessSupervisionUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProcessSupervisionUnsupportedError";
  }
}
