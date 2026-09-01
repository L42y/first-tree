import type { CapabilityEntry } from "@first-tree/shared";
import { supportsDefaultProviderProcessSupervision } from "../../runtime/provider-support/index.js";
import { type DetectOutcome, runDetect } from "../capabilities/detect.js";
import { findZcodeExecutableOnPath, resolveZcodeRuntimeBinary } from "./binary.js";

export type ZcodeProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readVersion?: (binary: string) => Promise<string>;
  nodeVersion?: () => string;
};

/**
 * Resolve-only capability probe. Authentication is provider-owned and is not
 * inferred by reading credentials; an unsupported process platform is reported
 * as an explicit error even when the binary exists.
 */
export async function probeZcodeCapability(deps: ZcodeProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const detected = await runDetect(async (): Promise<DetectOutcome> => {
    const resolution = await resolveZcodeRuntimeBinary(env, {
      findOnPath: deps.findOnPath ?? findZcodeExecutableOnPath,
      readVersion: deps.readVersion,
      nodeVersion: deps.nodeVersion,
    });
    if (resolution.ok) return { installed: true, runtimeSource: "path", runtimePath: resolution.binary };
    return { installed: false, error: resolution.error };
  });
  if (detected.state !== "ok" || supportsDefaultProviderProcessSupervision(deps.platform)) return detected;
  return {
    ...detected,
    state: "error",
    available: false,
    error:
      "ZCode is installed, but First Tree cannot supervise it on Windows until the client-wide " +
      "pre-admission Job Object supervisor is available.",
  };
}
