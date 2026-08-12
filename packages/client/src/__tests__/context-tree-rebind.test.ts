import { describe, expect, it, vi } from "vitest";
import type { ContextTreeBindingResolution } from "../runtime/bootstrap.js";
import { refreshContextTreeBinding } from "../runtime/context-tree-rebind.js";

const BOUND: ContextTreeBindingResolution = {
  status: "bound",
  binding: { path: "/clones/abc", repoUrl: "https://github.com/acme/ct", branch: "main" },
};

describe("refreshContextTreeBinding", () => {
  it("returns the bound resolution from the resolver", async () => {
    expect(await refreshContextTreeBinding(async () => BOUND)).toEqual(BOUND);
  });

  it("calls the resolver on every refresh — the caller owns rate-limiting (no bound short-circuit here)", async () => {
    const resolve = vi.fn(async () => BOUND);
    await refreshContextTreeBinding(resolve);
    await refreshContextTreeBinding(resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("returns the explicit-unbind resolution when the org has no tree configured", async () => {
    expect(await refreshContextTreeBinding(async () => ({ status: "explicitly-unbound" as const }))).toEqual({
      status: "explicitly-unbound",
    });
  });

  it("returns the unresolved resolution when the binding cannot be confirmed", async () => {
    expect(await refreshContextTreeBinding(async () => ({ status: "unresolved" as const }))).toEqual({
      status: "unresolved",
    });
  });

  it("swallows a resolver failure and degrades to unresolved (fail closed for the Tree)", async () => {
    expect(
      await refreshContextTreeBinding(async () => {
        throw new Error("network down");
      }),
    ).toEqual({ status: "unresolved" });
  });
});
