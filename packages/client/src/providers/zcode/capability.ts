import type { CapabilityEntry } from "@first-tree/shared";
import { supportsDefaultProviderProcessSupervision } from "../../runtime/provider-support/index.js";
import { type DetectOutcome, runDetect } from "../capabilities/detect.js";
import { findZcodeExecutableOnPath, formatZcodeBinaryMissingMessage } from "./binary.js";

export type ZcodeProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Resolve-only capability probe. Authentication is provider-owned and is not
 * inferred by reading credentials; an unsupported process platform is reported
 * as an explicit error even when the binary exists.
 */
export async function probeZcodeCapability(deps: ZcodeProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const detected = await runDetect(async (): Promise<DetectOutcome> => {
    const runtimePath = (deps.findOnPath ?? findZcodeExecutableOnPath)(env);
    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };
    return {
      installed: false,
      error: formatZcodeBinaryMissingMessage("no zcode binary resolved on this host"),
    };
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
