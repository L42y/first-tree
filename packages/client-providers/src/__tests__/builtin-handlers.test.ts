import { RUNTIME_PROVIDER_IDS } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinHandlerRegistry, resolveAndLogClaudeExecutable } from "../providers/builtin-registry.js";

describe("Built-in Handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const id of RUNTIME_PROVIDER_IDS) {
    it(`${id} factory returns a valid session-oriented handler`, () => {
      const registry = createBuiltinHandlerRegistry({
        resolveExecutable: () => ({ path: undefined, source: "default" }),
      });
      const factory = registry[id];
      expect(typeof factory).toBe("function");
      const handler = factory({
        runtimeProvider: id,
        workspaceRoot: "/tmp/test",
      });
      expect(typeof handler.start).toBe("function");
      expect(typeof handler.resume).toBe("function");
      expect(typeof handler.inject).toBe("function");
      expect(typeof handler.suspend).toBe("function");
      expect(typeof handler.shutdown).toBe("function");
    });
  }

  it("logs the SDK bundled binary fallback when no Claude executable is resolved", () => {
    const info = vi.fn();
    // Inject a resolver that finds nothing — hermetic against the dev machine's
    // real PATH / well-known install dirs and any login-shell probe.
    resolveAndLogClaudeExecutable({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
      log: { info },
    });

    expect(info).toHaveBeenCalledWith(expect.stringContaining("using SDK bundled native binary"));
  });
});
