import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PROVIDER_IDS } from "@first-tree/shared";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");
const repoRoot = join(clientSrc, "..", "..", "..");

/** Quote tokens derived from the Zod ID set — auto-expands when a provider is added. */
const PROVIDER_LITERAL_TOKENS: readonly string[] = RUNTIME_PROVIDER_IDS.flatMap((id) => [`"${id}"`, `'${id}'`]);

const THIRD_PARTY_SDK_IMPORTS = [
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex-sdk",
  "@botiverse/kimi-code-sdk",
  "@agentclientprotocol/sdk",
] as const;

/** Unique composition roots allowed to name concrete providers / import adapters. */
const COMPOSITION_ALLOWLIST = new Set([
  "providers/builtin-registry.ts",
  "providers/builtin-probes.ts",
  "providers/skill-roots.ts",
  "handlers/index.ts",
]);

/** Generic modules that must stay provider-neutral after this foundation PR. */
const GUARDED_CLIENT_FILES = [
  "runtime/capabilities/index.ts",
  "runtime/managed-skills.ts",
  "runtime/runtime.ts",
  "runtime/handler.ts",
  "runtime/runtime-notice.ts",
  "handlers/auth-error-hint.ts",
] as const;

/** Live presentation consumers that must derive catalog-owned copy. */
const CATALOG_CONSUMER_FILES = [
  "packages/web/src/components/new-agent-dialog.tsx",
  "packages/web/src/pages/agent-detail/runtime-section.tsx",
  "packages/web/src/pages/clients/cards/shared/providers.ts",
  "packages/client/src/handlers/auth-error-hint.ts",
  "packages/client/src/runtime/runtime-notice.ts",
  "packages/client/src/runtime/cursor-binary.ts",
  "packages/client/src/runtime/grok-binary.ts",
  "packages/client/src/runtime/opencode-binary.ts",
  "packages/client/src/runtime/pi-binary.ts",
] as const;

function listFilesRecursive(root: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
      out.push(...listFilesRecursive(path, predicate));
    } else if (predicate(path)) {
      out.push(path);
    }
  }
  return out;
}

function containsAnyProviderLiteral(source: string): string | null {
  for (const token of PROVIDER_LITERAL_TOKENS) {
    if (source.includes(token)) return token;
  }
  return null;
}

describe("runtime provider architecture guard", () => {
  it("keeps migrated generic client files free of concrete provider literals and handler imports", () => {
    for (const rel of GUARDED_CLIENT_FILES) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      const relPosix = rel.replaceAll("\\", "/");

      if (COMPOSITION_ALLOWLIST.has(relPosix)) {
        continue;
      }

      if (relPosix === "runtime/managed-skills.ts") {
        expect(source).toContain("PROVIDER_SKILL_ROOTS");
        expect(source).not.toContain("getProviderSkillRoots");
        const hit = containsAnyProviderLiteral(source);
        // managed-skills may mention providers only via typed RuntimeProvider params;
        // forbid hard-coded skill-root maps and quoted provider ids.
        expect(hit, `${rel} must not hard-code provider literal ${hit}`).toBeNull();
        continue;
      }

      if (relPosix === "runtime/capabilities/index.ts") {
        expect(source).toContain("BUILTIN_PROVIDER_PROBES");
        expect(source).toContain("RUNTIME_PROVIDER_IDS");
        expect(source).not.toContain("peekInstalledBuiltinProviderRegistry");
        expect(source).not.toContain("installBuiltinProviderRegistry");
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not contain ${hit}`).toBeNull();
        // Generic import rule: no concrete capability modules.
        expect(source).not.toMatch(/from "\.\/[^"]+\.js"/);
        continue;
      }

      if (relPosix === "handlers/auth-error-hint.ts") {
        expect(source).toContain("runtimeProviderChatAuthLoginPhrase");
        expect(source).toContain("runtimeProviderAuthOwnerLabel");
        expect(source).not.toMatch(/case ["']codex["']/);
        // Detection keywords may mention provider names in comments/strings;
        // forbid runtime-id branching for login/owner copy.
        expect(source).not.toMatch(/runtime\s*===\s*["']/);
        continue;
      }

      if (relPosix === "runtime/runtime-notice.ts") {
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toMatch(/function providerLabel/);
        expect(source).not.toMatch(/case ["']codex["']:\s*return ["']Codex["']/);
        continue;
      }

      expect(source).not.toMatch(/from ["'].*handlers\/(claude-code|codex|cursor|grok|kimi-code|opencode|pi)/);
      if (relPosix === "runtime/handler.ts" || relPosix === "runtime/runtime.ts") {
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not contain ${hit}`).toBeNull();
        expect(source).not.toContain("installHandlers");
      }
    }
  });

  it("names only the concrete composition files as registration roots", () => {
    for (const rel of ["handlers/index.ts", "providers/builtin-registry.ts"] as const) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      expect(source).toContain("RUNTIME_PROVIDER_IDS");
      expect(source).toContain("createBuiltinHandlerRegistry");
      expect(source).not.toContain("installBuiltinProviderRegistry");
      expect(source).not.toContain("installedRegistry");
      expect(source).not.toMatch(/probe\s*:/);
      expect(source).not.toMatch(/skillRoot\s*:/);
    }
  });

  it("keeps third-party provider SDKs out of shared and web packages", () => {
    const sharedSrc = join(repoRoot, "packages/shared/src");
    const webSrc = join(repoRoot, "packages/web/src");
    const files = [
      ...listFilesRecursive(sharedSrc, (p) => p.endsWith(".ts") || p.endsWith(".tsx")),
      ...listFilesRecursive(webSrc, (p) => p.endsWith(".ts") || p.endsWith(".tsx")),
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const sdk of THIRD_PARTY_SDK_IMPORTS) {
        expect(source, `${relative(repoRoot, file)} must not import ${sdk}`).not.toContain(`from "${sdk}"`);
        expect(source, `${relative(repoRoot, file)} must not import ${sdk}`).not.toContain(`from '${sdk}'`);
      }
    }
  });

  it("keeps live catalog consumers on shared helpers (not parallel switches)", () => {
    const providersTs = readFileSync(
      join(repoRoot, "packages/web/src/pages/clients/cards/shared/providers.ts"),
      "utf8",
    );
    expect(providersTs).toContain("RUNTIME_PROVIDER_CATALOG");
    expect(providersTs).toContain("enabledRuntimeProviders");
    expect(providersTs).toContain("runtimeProviderInstallCommand");
    expect(providersTs).toContain("recordByRuntimeProvider");
    expect(providersTs).not.toMatch(
      /export const PROVIDER_LABEL: Record<RuntimeProvider, string> = \{\s*"claude-code":/,
    );

    for (const rel of CATALOG_CONSUMER_FILES) {
      const source = readFileSync(join(repoRoot, rel), "utf8");
      if (rel.endsWith("new-agent-dialog.tsx")) {
        expect(source).toContain("pickPreferredRuntimeProvider");
        expect(source).toContain("enabledOkRuntimeProviders");
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toContain("Object.entries(activeCapabilities)");
        expect(source).not.toContain('provider === "claude-code"');
        expect(source).not.toMatch(/function prettyRuntimeLabel/);
        expect(source).not.toMatch(/function asRuntimeProvider/);
      }
      if (rel.endsWith("runtime-section.tsx")) {
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toMatch(/const RUNTIME_NAME/);
      }
      if (rel.endsWith("auth-error-hint.ts")) {
        expect(source).toContain("runtimeProviderChatAuthLoginPhrase");
        expect(source).toContain("runtimeProviderAuthOwnerLabel");
      }
      if (rel.endsWith("runtime-notice.ts")) {
        expect(source).toContain("runtimeProviderLabel");
      }
      if (rel.endsWith("cursor-binary.ts") || rel.endsWith("grok-binary.ts")) {
        expect(source).toMatch(/from "@first-tree\/shared"/);
        expect(source).toContain("INSTALL_COMMAND");
      }
      if (rel.endsWith("opencode-binary.ts")) {
        expect(source).toContain("OPENCODE_MINIMUM_VERSION");
        expect(source).toContain("runtimeProviderInstallCommand");
      }
      if (rel.endsWith("pi-binary.ts")) {
        expect(source).toContain("runtimeProviderInstallCommand");
        expect(source).toContain("runtimeProviderLoginCommand");
      }
    }
  });
});
