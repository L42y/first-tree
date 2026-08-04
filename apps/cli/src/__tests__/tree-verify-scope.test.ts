import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyTreeRoot } from "../commands/tree/verify.js";

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "tree-scope-verify-"));
  mkdirSync(join(root, "members"));
  writeFileSync(join(root, "NODE.md"), "---\ntitle: Root\nowners: [admin]\n---\n");
  writeFileSync(join(root, "members", "NODE.md"), "---\ntitle: Members\nowners: [admin]\n---\n");
  return root;
}

describe("tree verify SCOPE.md", () => {
  it("accepts a domain-neutral natural-language scope without fixed sections", () => {
    const root = tree();
    writeFileSync(
      join(root, "SCOPE.md"),
      "---\nschemaVersion: 1\n---\nThis Tree covers legal operations and customer contracts.\n",
    );
    expect(verifyTreeRoot(root).checks.scope).toEqual({ ok: true });
  });

  it("rejects invalid or empty routing scope", () => {
    const root = tree();
    writeFileSync(join(root, "SCOPE.md"), "---\nschemaVersion: 1\n---\n");
    expect(verifyTreeRoot(root).checks.scope.ok).toBe(false);
  });

  it("rejects broken symlinks and directories at the reserved root path", () => {
    const broken = tree();
    symlinkSync("missing.md", join(broken, "SCOPE.md"));
    expect(verifyTreeRoot(broken).checks.scope.ok).toBe(false);

    const directory = tree();
    mkdirSync(join(directory, "SCOPE.md"));
    expect(verifyTreeRoot(directory).checks.scope.ok).toBe(false);
  });
});
