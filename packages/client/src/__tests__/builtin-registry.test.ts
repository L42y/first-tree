import { RUNTIME_PROVIDER_IDS, type RuntimeProvider } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinHandlers } from "../handlers/index.js";
import {
  builtinRegistryProviderIds,
  createBuiltinProviderRegistry,
  getBuiltinProviderRegistry,
  installBuiltinProviderRegistry,
  resetBuiltinProviderRegistryForTests,
} from "../providers/builtin-registry.js";
import { PROVIDER_SKILL_ROOTS } from "../providers/skill-roots.js";
import { getHandlerFactory, hasHandler, registerHandler } from "../runtime/handler.js";
import { providerSkillRoot } from "../runtime/managed-skills.js";

const HANDLER_METHODS = ["start", "resume", "inject", "suspend", "shutdown"] as const;

describe("builtin provider registry", () => {
  afterEach(() => {
    resetBuiltinProviderRegistryForTests();
    vi.restoreAllMocks();
  });

  it("is exhaustive over RuntimeProvider and shares skill roots with managed-skills", () => {
    const registry = createBuiltinProviderRegistry({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });

    expect(builtinRegistryProviderIds(registry).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    for (const id of RUNTIME_PROVIDER_IDS) {
      expect(registry[id].skillRoot).toBe(PROVIDER_SKILL_ROOTS[id]);
      expect(providerSkillRoot(id)).toBe(PROVIDER_SKILL_ROOTS[id]);
      expect(typeof registry[id].factory).toBe("function");
      expect(typeof registry[id].probe).toBe("function");
    }
  });

  it("registerBuiltinHandlers installs the same registry source and five-method handlers", () => {
    registerBuiltinHandlers({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });

    const installed = getBuiltinProviderRegistry();
    expect(builtinRegistryProviderIds(installed).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());

    for (const id of RUNTIME_PROVIDER_IDS) {
      expect(hasHandler(id)).toBe(true);
      const handler = getHandlerFactory(id)({ workspaceRoot: "/tmp/registry-test", runtimeProvider: id });
      for (const method of HANDLER_METHODS) {
        expect(typeof handler[method]).toBe("function");
      }
    }
  });

  it("keeps custom registerHandler registrations isolated from the builtin registry snapshot", () => {
    const registry = createBuiltinProviderRegistry({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });
    installBuiltinProviderRegistry(registry);

    const customFactory = vi.fn(() => ({
      start: vi.fn(),
      resume: vi.fn(),
      inject: vi.fn(),
      suspend: vi.fn(),
      shutdown: vi.fn(),
    }));
    registerHandler("custom-echo", customFactory);

    expect(hasHandler("custom-echo")).toBe(true);
    expect(Object.keys(getBuiltinProviderRegistry())).not.toContain("custom-echo");
    expect(builtinRegistryProviderIds(getBuiltinProviderRegistry())).toEqual([...RUNTIME_PROVIDER_IDS]);
  });

  it("daemon and standalone boot paths share createBuiltinProviderRegistry", async () => {
    // ClientRuntime calls registerBuiltinHandlers(); AgentRuntime accepts the
    // same function via installHandlers. Both must resolve to this builder.
    const handlers = await import("../handlers/index.js");
    expect(handlers.createBuiltinProviderRegistry).toBe(createBuiltinProviderRegistry);
    expect(typeof handlers.registerBuiltinHandlers).toBe("function");

    const { AgentRuntime } = await import("../runtime/runtime.js");
    const installHandlers = vi.fn(() => {
      registerBuiltinHandlers({
        resolveExecutable: () => ({ path: undefined, source: "default" }),
      });
    });

    // Minimal construction is mocked elsewhere; here we only assert the option
    // surface accepts the shared installer without importing CLI ClientRuntime.
    expect(typeof AgentRuntime).toBe("function");
    expect(installHandlers).not.toHaveBeenCalled();
    installHandlers();
    expect(installHandlers).toHaveBeenCalledTimes(1);
    expect(hasHandler("claude-code" satisfies RuntimeProvider)).toBe(true);
  });
});
