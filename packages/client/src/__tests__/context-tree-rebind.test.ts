import { describe, expect, it, vi } from "vitest";
import { reresolveUnboundTree } from "../runtime/context-tree-rebind.js";

const BINDING = { path: "/clones/abc", repoUrl: "https://github.com/acme/ct", branch: "main" };

describe("reresolveUnboundTree", () => {
  it("re-resolves when currently unbound (undefined path)", async () => {
    expect(await reresolveUnboundTree(undefined, async () => BINDING)).toEqual(BINDING);
  });

  it("treats an empty-string path as unbound and re-resolves", async () => {
    expect(await reresolveUnboundTree("", async () => BINDING)).toEqual(BINDING);
  });

  it("re-resolves when already bound because the old binding is not a lease", async () => {
    const resolve = vi.fn(async () => BINDING);
    expect(await reresolveUnboundTree("/already/bound", resolve)).toEqual(BINDING);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("returns null when the org has no tree configured yet", async () => {
    expect(await reresolveUnboundTree(undefined, async () => null)).toBeNull();
  });

  it("propagates resolver failure so stale authority cannot start", async () => {
    await expect(
      reresolveUnboundTree(undefined, async () => {
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");
  });
});
