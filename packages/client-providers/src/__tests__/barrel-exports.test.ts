import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const providersSrc = join(dirname(fileURLToPath(import.meta.url)), "..");
const providersPkgRoot = join(providersSrc, "..");

describe("public barrel exports", { timeout: 30_000 }, () => {
  it("loads the provider package entrypoint exports", async () => {
    const api = await import("../index.js");

    expect(api.createBuiltinHandlerRegistry).toBeDefined();
    expect(api.resolveAndLogClaudeExecutable).toBeDefined();
    expect(api.RUNTIME_AUTH_DRIVERS).toBeDefined();
    expect(api.BUILTIN_PROVIDER_PROBES).toBeDefined();
    expect(api.probeCapabilities).toBeDefined();
    expect(api.discoverProviderModels).toBeDefined();

    // Private composition / runtime owners are not re-exported from providers.
    expect(api).not.toHaveProperty("FirstTreeHubSDK");
    expect(api).not.toHaveProperty("FirstTreeSDK");
    expect(api).not.toHaveProperty("ClientConnection");
    expect(api).not.toHaveProperty("AgentSlot");
    expect(api).not.toHaveProperty("AgentRuntime");
    expect(api).not.toHaveProperty("SessionManager");
    expect(api).not.toHaveProperty("SessionRegistry");
    expect(api).not.toHaveProperty("registerBuiltinHandlers");
    expect(api).not.toHaveProperty("registerHandler");
    expect(api).not.toHaveProperty("getHandlerFactory");
    expect(api).not.toHaveProperty("hasHandler");
    expect(api).not.toHaveProperty("contracts");
    expect(api).not.toHaveProperty("provider-support");
    expect(api).not.toHaveProperty("prepareManagedSession");
    expect(api).not.toHaveProperty("noopDeliveryToken");
    expect(api).not.toHaveProperty("requireDeliveryToken");

    const pkg = JSON.parse(readFileSync(join(providersPkgRoot, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports ?? {}).sort()).toEqual(["."]);
    expect(pkg.exports).not.toHaveProperty("./contracts");
    expect(pkg.exports).not.toHaveProperty("./provider-support");
    expect(pkg.exports).not.toHaveProperty("./observability");

    const rootIndex = readFileSync(join(providersSrc, "index.ts"), "utf8");
    expect(rootIndex).not.toMatch(/@first-tree\/cloud-client/);
    expect(rootIndex).not.toMatch(/client-runtime\/(?!contracts|provider-support)/);
  });

  it("keeps runtime and cloud barrels on their owning packages", async () => {
    const runtime = await import("@first-tree/client-runtime");
    expect(runtime.AgentSlot).toBeDefined();
    expect(runtime.AgentRuntime).toBeDefined();
    expect(runtime.cleanAgentWorkspaces).toBeDefined();
    expect(runtime).not.toHaveProperty("SessionManager");
    expect(runtime).not.toHaveProperty("SessionRegistry");
    expect(runtime).not.toHaveProperty("prepareManagedSession");

    const observability = await import("@first-tree/cloud-client/observability");
    expect(observability.createLogger).toBeDefined();
    expect(observability.rootLogger).toBeDefined();

    const cloud = await import("@first-tree/cloud-client");
    expect(cloud.FirstTreeHubSDK).toBeDefined();
    expect(cloud.FirstTreeSDK).toBe(cloud.FirstTreeHubSDK);
  });
});
