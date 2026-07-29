import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function paths(root: string): ContextBindingStorePaths {
  return {
    configPath: join(root, "config", "context.yaml"),
    lockPath: join(root, "state", "context", "install.lock"),
  };
}

describe("context binding store", () => {
  it("atomically stores one Team per provider and checkout", () => {
    const root = makeTempDir("context-binding-");
    const storePaths = paths(root);
    const binding = {
      provider: "codex" as const,
      checkoutRoot: "/work/payments",
      repositoryKey: "github.com/acme/payments",
      organizationId: "org_acme",
    };

    writeContextBinding(binding, { paths: storePaths });
    writeContextBinding(binding, { paths: storePaths });

    expect(readContextIntegrationConfig(storePaths).bindings).toEqual([binding]);
    expect(findContextBinding("codex", "/work/payments", storePaths)).toEqual(binding);
    expect(statSync(storePaths.configPath).mode & 0o777).toBe(0o600);
  });

  it("requires explicit confirmation before replacing the Team", () => {
    const root = makeTempDir("context-binding-replace-");
    const storePaths = paths(root);
    const oldBinding = {
      provider: "claude-code" as const,
      checkoutRoot: "/work/payments",
      repositoryKey: "github.com/acme/payments",
      organizationId: "org_old",
    };
    const newBinding = { ...oldBinding, organizationId: "org_new" };
    writeContextBinding(oldBinding, { paths: storePaths });

    expect(() => writeContextBinding(newBinding, { paths: storePaths })).toThrow(
      ContextBindingReplacementRequiredError,
    );
    writeContextBinding(newBinding, { paths: storePaths, allowReplace: true });
    expect(findContextBinding("claude-code", "/work/payments", storePaths)?.organizationId).toBe("org_new");
  });

  it("does not apply a confirmed plan after the observed binding changes", () => {
    const root = makeTempDir("context-binding-cas-");
    const storePaths = paths(root);
    const observed = {
      provider: "codex" as const,
      checkoutRoot: "/work/payments",
      repositoryKey: "github.com/acme/payments",
      organizationId: "org_observed",
    };
    const intervening = { ...observed, organizationId: "org_intervening" };
    writeContextBinding(observed, { paths: storePaths });
    writeContextBinding(intervening, { paths: storePaths, allowReplace: true });

    expect(() =>
      writeContextBinding(
        { ...observed, organizationId: "org_requested" },
        {
          paths: storePaths,
          allowReplace: true,
          expectedPrevious: observed,
        },
      ),
    ).toThrow(ContextBindingsChangedError);
    expect(findContextBinding("codex", "/work/payments", storePaths)).toEqual(intervening);
  });

  it("removes only the requested checkout unless all is explicit", () => {
    const root = makeTempDir("context-binding-remove-");
    const storePaths = paths(root);
    for (const checkoutRoot of ["/work/a", "/work/b"]) {
      writeContextBinding(
        {
          provider: "codex",
          checkoutRoot,
          repositoryKey: `github.com/acme/${checkoutRoot.at(-1)}`,
          organizationId: "org_acme",
        },
        { paths: storePaths },
      );
    }

    expect(removeContextBindings("codex", { checkoutRoot: "/work/a", paths: storePaths }).removed).toHaveLength(1);
    expect(removeContextBindings("codex", { all: true, paths: storePaths }).removed).toHaveLength(1);
  });

  it("fails closed on malformed config without overwriting it", () => {
    const root = makeTempDir("context-binding-invalid-");
    const storePaths = paths(root);
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(storePaths.configPath, "bindings: nope\n");
    expect(() => readContextIntegrationConfig(storePaths)).toThrow(/Invalid First Tree Context binding config/);
    expect(readFileSync(storePaths.configPath, "utf8")).toBe("bindings: nope\n");
  });

  it("does not steal a live integration operation lock", () => {
    const root = makeTempDir("context-binding-lock-");
    const storePaths = paths(root);
    mkdirSync(join(root, "state", "context"), { recursive: true });
    writeFileSync(storePaths.lockPath, `${process.pid}\n`);

    expect(() =>
      writeContextBinding(
        {
          provider: "codex",
          checkoutRoot: "/work/payments",
          repositoryKey: "github.com/acme/payments",
          organizationId: "org_acme",
        },
        { paths: storePaths },
      ),
    ).toThrow("Another First Tree Context integration change is already running.");
  });
});
