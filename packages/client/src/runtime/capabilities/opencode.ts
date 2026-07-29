import type { CapabilityEntry } from "@first-tree/shared";
import { findOpenCodeExecutableOnPath, formatOpenCodeBinaryMissingMessage } from "../opencode-binary.js";
import { type DetectOutcome, runDetect } from "./detect.js";

export type OpenCodeProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
};

/**
 * Install-only probe. It deliberately does not launch OpenCode, inspect its
 * config, or infer provider authentication.
 */
export async function probeOpenCodeCapability(deps: OpenCodeProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const findOnPath = deps.findOnPath ?? findOpenCodeExecutableOnPath;
  return runDetect(async (): Promise<DetectOutcome> => {
    const runtimePath = findOnPath(env);
    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };
    return {
      installed: false,
      error: formatOpenCodeBinaryMissingMessage("no opencode binary resolved on this host"),
    };
  });
}
