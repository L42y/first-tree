import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContextBindingReplacementRequiredError,
  type ContextBindingStorePaths,
  ContextBindingsChangedError,
  findContextBinding,
  readContextIntegrationConfig,
  removeContextBindings,
  writeContextBinding,
} from "../core/context-integration/context-binding-store.js";

function paths(root: string): ContextBindingStorePaths {
  return {
    configPath: join(root, "config", "context.yaml"),
    lockPath: join(root, "state", "context", "install.lock"),
    legacyBackupPath: join(root, "config", "context.yaml.v1.bak"),
  };
}

function temporaryPaths(prefix: string): ContextBindingStorePaths {
  return paths(mkdtempSync(join(tmpdir(), prefix)));
}

describe("context binding store v2", () => {
  it("stores one Team per provider and project and uses longest ancestor matching", () => {
    const storePaths = temporaryPaths("context-binding-");
    const parent = {
      provider: "codex" as const,
      project: { kind: "path" as const, root: "/work" },
      organizationId: "org_parent",
    };
    const nested = {
      provider: "codex" as const,
      project: { kind: "path" as const, root: "/work/payments" },
      organizationId: "org_nested",
    };
    writeContextBinding(parent, { paths: storePaths });
    writeContextBinding(nested, { paths: storePaths });

    expect(findContextBinding("codex", { kind: "path", root: "/work/payments/src" }, storePaths)).toEqual(nested);
    expect(findContextBinding("codex", { kind: "path", root: "/workspace" }, storePaths)).toBeNull();
    expect(statSync(storePaths.configPath).mode & 0o777).toBe(0o600);
  });

  it("keeps pathless exact and never uses it as a path fallback", () => {
    const storePaths = temporaryPaths("context-binding-pathless-");
    const binding = {
      provider: "codex" as const,
      project: { kind: "pathless" as const },
      organizationId: "org_pathless",
    };
    writeContextBinding(binding, { paths: storePaths });

    expect(findContextBinding("codex", { kind: "pathless" }, storePaths)).toEqual(binding);
    expect(findContextBinding("codex", { kind: "path", root: "/work/project" }, storePaths)).toBeNull();
  });

  it("requires confirmation and compare-and-swap when replacing a project Team", () => {
    const storePaths = temporaryPaths("context-binding-replace-");
    const observed = {
      provider: "claude-code" as const,
      project: { kind: "path" as const, root: "/work/payments" },
      organizationId: "org_old",
    };
    const intervening = { ...observed, organizationId: "org_intervening" };
    writeContextBinding(observed, { paths: storePaths });
    expect(() => writeContextBinding(intervening, { paths: storePaths })).toThrow(
      ContextBindingReplacementRequiredError,
    );
    writeContextBinding(intervening, { paths: storePaths, allowReplace: true });
    expect(() =>
      writeContextBinding(
        { ...observed, organizationId: "org_requested" },
        { paths: storePaths, allowReplace: true, expectedPrevious: observed },
      ),
    ).toThrow(ContextBindingsChangedError);
  });

  it("removes only the requested project unless all is explicit", () => {
    const storePaths = temporaryPaths("context-binding-remove-");
    for (const root of ["/work/a", "/work/b"]) {
      writeContextBinding(
        { provider: "codex", project: { kind: "path", root }, organizationId: "org_acme" },
        { paths: storePaths },
      );
    }
    expect(
      removeContextBindings("codex", {
        project: { kind: "path", root: "/work/a" },
        paths: storePaths,
      }).removed,
    ).toHaveLength(1);
    expect(removeContextBindings("codex", { all: true, paths: storePaths }).removed).toHaveLength(1);
  });

  it("atomically migrates v1, drops repository identity, and preserves a fixed backup", () => {
    const storePaths = temporaryPaths("context-binding-migrate-");
    mkdirSync(dirname(storePaths.configPath), { recursive: true });
    const legacy = [
      "schemaVersion: 1",
      "bindings:",
      "  - provider: codex",
      "    checkoutRoot: /work/plain-project",
      "    repositoryKey: github.com/acme/repo",
      "    organizationId: org_acme",
      "",
    ].join("\n");
    writeFileSync(storePaths.configPath, legacy);

    expect(readContextIntegrationConfig(storePaths)).toEqual({
      schemaVersion: 2,
      bindings: [
        {
          provider: "codex",
          project: { kind: "path", root: "/work/plain-project" },
          organizationId: "org_acme",
        },
      ],
    });
    expect(readFileSync(storePaths.legacyBackupPath ?? "", "utf8")).toBe(legacy);
    expect(statSync(storePaths.legacyBackupPath ?? "").mode & 0o777).toBe(0o600);
    expect(readFileSync(storePaths.configPath, "utf8")).not.toContain("repositoryKey");
  });

  it("fails closed on malformed config without overwriting it", () => {
    const storePaths = temporaryPaths("context-binding-invalid-");
    mkdirSync(dirname(storePaths.configPath), { recursive: true });
    writeFileSync(storePaths.configPath, "bindings: nope\n");
    expect(() => readContextIntegrationConfig(storePaths)).toThrow(/Invalid First Tree Context binding config/);
    expect(readFileSync(storePaths.configPath, "utf8")).toBe("bindings: nope\n");
  });

  it("does not steal a live integration operation lock", () => {
    const storePaths = temporaryPaths("context-binding-lock-");
    mkdirSync(dirname(storePaths.lockPath), { recursive: true });
    writeFileSync(storePaths.lockPath, `${process.pid}\n`);
    expect(() =>
      writeContextBinding(
        {
          provider: "codex",
          project: { kind: "path", root: "/work/payments" },
          organizationId: "org_acme",
        },
        { paths: storePaths },
      ),
    ).toThrow("Another First Tree Context integration change is already running.");
  });
});
