import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ContextGrantStorePaths,
  ContextGrantsChangedError,
  contextGrantStoreFingerprintAfterGrant,
  inspectContextGrantStore,
  prepareContextGrantStoreForApply,
  readContextIntegrationConfig,
  removeContextGrants,
  resolveContextGrantCandidates,
  writeContextGrant,
} from "../core/context-integration/context-binding-store.js";

const roots: string[] = [];
afterEach(() => roots.splice(0));

function paths(): ContextGrantStorePaths {
  const root = mkdtempSync(join(tmpdir(), "context-grants-"));
  roots.push(root);
  return {
    configPath: join(root, "context.yaml"),
    lockPath: join(root, "state", "context", "install.lock"),
    legacyV1BackupPath: join(root, "context.yaml.v1.bak"),
    legacyV2BackupPath: join(root, "context.yaml.v2.bak"),
  };
}

describe("v3 Context grants", () => {
  it("returns all Teams at the deepest directory and otherwise global Teams", () => {
    const store = paths();
    for (const grant of [
      { provider: "codex" as const, organizationId: "global", activationScope: { kind: "global" as const } },
      {
        provider: "codex" as const,
        organizationId: "a",
        activationScope: { kind: "directory" as const, root: "/work" },
      },
      {
        provider: "codex" as const,
        organizationId: "b",
        activationScope: { kind: "directory" as const, root: "/work/app" },
      },
      {
        provider: "codex" as const,
        organizationId: "c",
        activationScope: { kind: "directory" as const, root: "/work/app" },
      },
    ])
      writeContextGrant(grant, { paths: store });
    expect(resolveContextGrantCandidates("codex", { kind: "path", root: "/work/app/src" }, store)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grant: expect.objectContaining({ organizationId: "b" }), priority: "directory" }),
        expect.objectContaining({ grant: expect.objectContaining({ organizationId: "c" }), priority: "directory" }),
      ]),
    );
    expect(
      resolveContextGrantCandidates("codex", { kind: "path", root: "/elsewhere" }, store)[0]?.grant.organizationId,
    ).toBe("global");
  });

  it("removes only the exact Team + scope grant", () => {
    const store = paths();
    writeContextGrant(
      { provider: "codex", organizationId: "a", activationScope: { kind: "global" } },
      { paths: store },
    );
    writeContextGrant(
      { provider: "codex", organizationId: "b", activationScope: { kind: "global" } },
      { paths: store },
    );
    removeContextGrants("codex", { organizationId: "a", activationScope: { kind: "global" }, paths: store });
    expect(readContextIntegrationConfig(store).grants).toEqual([
      { provider: "codex", organizationId: "b", activationScope: { kind: "global" } },
    ]);
  });

  it("atomically backs up v2 and starts empty v3 without widening old bindings", () => {
    const store = paths();
    writeFileSync(
      store.configPath,
      "schemaVersion: 2\nbindings:\n  - provider: codex\n    project:\n      kind: pathless\n    organizationId: old-team\n",
      { mode: 0o600 },
    );
    expect(readContextIntegrationConfig(store)).toEqual({ schemaVersion: 3, grants: [] });
    expect(store.legacyV2BackupPath).toBeDefined();
    if (!store.legacyV2BackupPath) throw new Error("expected legacy v2 backup path");
    expect(readFileSync(store.legacyV2BackupPath, "utf8")).toContain("old-team");
    expect(statSync(store.legacyV2BackupPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(store.configPath, "utf8")).toContain("schemaVersion: 3");
  });

  it("plans legacy retirement without mutation, then retires only under the exact apply fence", () => {
    const store = paths();
    writeFileSync(
      store.configPath,
      "schemaVersion: 2\nbindings:\n  - provider: codex\n    project:\n      kind: pathless\n    organizationId: old-team\n",
      { mode: 0o600 },
    );
    const planned = inspectContextGrantStore(store);
    const grant = {
      provider: "codex" as const,
      organizationId: "new-team",
      activationScope: { kind: "global" as const },
    };
    expect(planned.kind).toBe("v2");
    expect(readFileSync(store.configPath, "utf8")).toContain("schemaVersion: 2");
    if (!store.legacyV2BackupPath) throw new Error("expected legacy v2 backup path");
    expect(existsSync(store.legacyV2BackupPath)).toBe(false);

    expect(
      prepareContextGrantStoreForApply(
        planned.fingerprint,
        contextGrantStoreFingerprintAfterGrant(planned, grant),
        grant,
        store,
      ),
    ).toEqual({ schemaVersion: 3, grants: [] });
    expect(existsSync(store.legacyV2BackupPath)).toBe(true);
  });

  it("accepts only the exact target grant as an idempotent Trust retry", () => {
    const store = paths();
    const planned = inspectContextGrantStore(store);
    const target = {
      provider: "codex" as const,
      organizationId: "target",
      activationScope: { kind: "global" as const },
    };
    const after = contextGrantStoreFingerprintAfterGrant(planned, target);
    writeContextGrant(target, { paths: store });
    expect(prepareContextGrantStoreForApply(planned.fingerprint, after, target, store).grants).toEqual([target]);

    writeContextGrant(
      { provider: "codex", organizationId: "concurrent", activationScope: { kind: "global" } },
      { paths: store },
    );
    expect(() => prepareContextGrantStoreForApply(planned.fingerprint, after, target, store)).toThrow(
      ContextGrantsChangedError,
    );
    removeContextGrants("codex", {
      organizationId: "target",
      activationScope: { kind: "global" },
      paths: store,
    });
    expect(() => prepareContextGrantStoreForApply(planned.fingerprint, after, target, store)).toThrow(
      ContextGrantsChangedError,
    );
  });
});
