import { describe, expect, it, vi } from "vitest";
import type { ContextTreeBindingResolution } from "../runtime/bootstrap.js";
import { reresolveUnboundTree } from "../runtime/context-tree-rebind.js";

const BOUND: ContextTreeBindingResolution = {
  status: "bound",
  binding: { path: "/clones/abc", repoUrl: "https://github.com/acme/ct", branch: "main" },
};

describe("reresolveUnboundTree", () => {
  it("re-resolves when currently unbound (undefined path)", async () => {
    expect(await reresolveUnboundTree(undefined, async () => BOUND)).toEqual(BOUND);
  });

  it("treats an empty-string path as unbound and re-resolves", async () => {
    expect(await reresolveUnboundTree("", async () => BOUND)).toEqual(BOUND);
  });

  it("does NOT re-resolve when already bound (steady state untouched)", async () => {
    const resolve = vi.fn();
    expect(await reresolveUnboundTree("/already/bound", resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns the explicit-unbind resolution when the org has no tree configured", async () => {
    expect(await reresolveUnboundTree(undefined, async () => ({ status: "explicitly-unbound" as const }))).toEqual({
      status: "explicitly-unbound",
    });
  });

  it("returns the unresolved resolution when the binding cannot be confirmed", async () => {
    expect(await reresolveUnboundTree(undefined, async () => ({ status: "unresolved" as const }))).toEqual({
      status: "unresolved",
    });
  });

  it("swallows a resolver failure and degrades to unresolved (session starts tree-less)", async () => {
    expect(
      await reresolveUnboundTree(undefined, async () => {
        throw new Error("network down");
      }),
    ).toEqual({ status: "unresolved" });
  });
});
