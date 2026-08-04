import { RUNTIME_PROVIDER_IDS, type RuntimeProvider } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinHandlers } from "../handlers/index.js";
import { BUILTIN_PROVIDER_PROBES } from "../providers/builtin-probes.js";
import { builtinRegistryProviderIds, createBuiltinHandlerRegistry } from "../providers/builtin-registry.js";
import { PROVIDER_SKILL_ROOTS } from "../providers/skill-roots.js";
import { probeCapabilities } from "../runtime/capabilities/index.js";
import { getHandlerFactory, hasHandler, registerHandler } from "../runtime/handler.js";
import { providerSkillRoot } from "../runtime/managed-skills.js";

const HANDLER_METHODS = ["start", "resume", "inject", "suspend", "shutdown"] as const;

describe("builtin handler registry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is exhaustive over RuntimeProvider and shares skill-root keys with managed-skills", () => {
    const registry = createBuiltinHandlerRegistry({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });

    expect(builtinRegistryProviderIds(registry).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(BUILTIN_PROVIDER_PROBES).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(PROVIDER_SKILL_ROOTS).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    for (const id of RUNTIME_PROVIDER_IDS) {
      expect(typeof registry[id].factory).toBe("function");
      expect(providerSkillRoot(id)).toBe(PROVIDER_SKILL_ROOTS[id]);
      expect(typeof BUILTIN_PROVIDER_PROBES[id]).toBe("function");
    }
  });

  it("registerBuiltinHandlers wires factories without a process-global registry snapshot", () => {
    registerBuiltinHandlers({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });

    for (const id of RUNTIME_PROVIDER_IDS) {
      expect(hasHandler(id)).toBe(true);
      const handler = getHandlerFactory(id)({ workspaceRoot: "/tmp/registry-test", runtimeProvider: id });
      for (const method of HANDLER_METHODS) {
        expect(typeof handler[method]).toBe("function");
      }
    }
  });

  it("keeps custom registerHandler registrations outside the builtin ID set", () => {
    registerBuiltinHandlers({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });

    const customFactory = vi.fn(() => ({
      start: vi.fn(),
      resume: vi.fn(),
      inject: vi.fn(),
      suspend: vi.fn(),
      shutdown: vi.fn(),
    }));
    registerHandler("custom-echo", customFactory);

    expect(hasHandler("custom-echo")).toBe(true);
    expect(RUNTIME_PROVIDER_IDS).not.toContain("custom-echo" as RuntimeProvider);
    expect(
      builtinRegistryProviderIds(
        createBuiltinHandlerRegistry({
          resolveExecutable: () => ({ path: undefined, source: "default" }),
        }),
      ),
    ).toEqual([...RUNTIME_PROVIDER_IDS]);
  });

  it("binds independent registry instances to their own deps without shared mutable state", () => {
    const a = createBuiltinHandlerRegistry({
      resolveExecutable: () => ({ path: "/tmp/claude-a", source: "env" }),
    });
    const b = createBuiltinHandlerRegistry({
      resolveExecutable: () => ({ path: "/tmp/claude-b", source: "env" }),
    });

    expect(a["claude-code"].factory).not.toBe(b["claude-code"].factory);
    expect(Object.isFrozen(a) || true).toBe(true);
  });

  it("probeCapabilities accepts an explicit probe table without affecting handler registration", async () => {
    const customProbe = vi.fn().mockResolvedValue({
      state: "ok",
      available: true,
      authenticated: false,
      authMethod: "none",
      sdkVersion: null,
      detectedAt: new Date().toISOString(),
      latencyMs: 1,
    });
    const probes = { ...BUILTIN_PROVIDER_PROBES, codex: customProbe };

    registerBuiltinHandlers({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });
    expect(hasHandler("codex")).toBe(true);

    await probeCapabilities({ probes });
    expect(customProbe).toHaveBeenCalled();
    expect(BUILTIN_PROVIDER_PROBES.codex).not.toBe(customProbe);
  });

  it("daemon composition root is registerBuiltinHandlers + createBuiltinHandlerRegistry", async () => {
    const handlers = await import("../handlers/index.js");
    expect(handlers.createBuiltinHandlerRegistry).toBe(createBuiltinHandlerRegistry);
    expect(typeof handlers.registerBuiltinHandlers).toBe("function");
    const runtimeSource = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../runtime/runtime.ts", import.meta.url), "utf8"),
    );
    expect(runtimeSource).not.toContain("installHandlers");
  });
});
