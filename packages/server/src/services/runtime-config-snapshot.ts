import type { AgentRuntimeConfig } from "@first-tree/shared";
import { ServiceUnavailableError } from "../errors.js";

const MAX_RUNTIME_CONFIG_RESOLUTION_ATTEMPTS = 3;

export class RuntimeConfigSnapshotChangedError extends Error {
  constructor() {
    super("Agent runtime config changed while its Resource snapshot was being resolved");
    this.name = "RuntimeConfigSnapshotChangedError";
  }
}

export async function resolveCurrentRuntimeConfig(
  loadConfig: () => Promise<AgentRuntimeConfig>,
  resolveConfig: (config: AgentRuntimeConfig) => Promise<AgentRuntimeConfig>,
  initialConfig?: AgentRuntimeConfig,
): Promise<AgentRuntimeConfig> {
  let config = initialConfig;
  for (let attempt = 0; attempt < MAX_RUNTIME_CONFIG_RESOLUTION_ATTEMPTS; attempt++) {
    config ??= await loadConfig();
    try {
      return await resolveConfig(config);
    } catch (error) {
      if (!(error instanceof RuntimeConfigSnapshotChangedError)) throw error;
      config = undefined;
    }
  }
  throw new ServiceUnavailableError("Agent runtime config changed repeatedly; retry the request");
}
