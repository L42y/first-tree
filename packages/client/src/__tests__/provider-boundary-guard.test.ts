import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");
const repoRoot = join(clientSrc, "..", "..", "..");

const PROVIDER_LITERALS = [
  "claude-code-tui",
  "claude-code",
  "kimi-code",
  "opencode",
  "codex",
  "cursor",
  "grok",
  '"pi"',
  "'pi'",
] as const;

const THIRD_PARTY_SDK_IMPORTS = [
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex-sdk",
  "@botiverse/kimi-code-sdk",
  "@agentclientprotocol/sdk",
] as const;

/** Generic modules that must stay provider-neutral after this foundation PR. */
const GUARDED_CLIENT_FILES = [
  "runtime/capabilities/index.ts",
  "runtime/managed-skills.ts",
  "runtime/runtime.ts",
  "runtime/handler.ts",
  "handlers/index.ts",
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

describe("runtime provider architecture guard", () => {
  it("keeps migrated generic client files free of concrete provider literals and handler imports", () => {
    for (const rel of GUARDED_CLIENT_FILES) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      const relPosix = rel.replaceAll("\\", "/");

      if (relPosix === "handlers/index.ts") {
        // Composition root may import concrete handlers, but must not hard-code
        // provider id string lists — registration iterates RUNTIME_PROVIDER_IDS.
        expect(source).toContain("RUNTIME_PROVIDER_IDS");
        expect(source).toContain("createBuiltinProviderRegistry");
        for (const literal of ['"claude-code"', '"codex"', '"cursor"', '"grok"', '"pi"']) {
          expect(source, `${rel} must not hard-code ${literal}`).not.toContain(`registerHandler(${literal}`);
        }
        continue;
      }

      if (relPosix === "runtime/managed-skills.ts") {
        // Skill roots come from the shared client skill-roots table.
        expect(source).toContain('from "../providers/skill-roots.js"');
        expect(source).not.toMatch(/"claude-code"\s*:\s*"\.claude\/skills"/);
        continue;
      }

      if (relPosix === "runtime/capabilities/index.ts") {
        expect(source).toContain("getBuiltinProviderProbes");
        expect(source).toContain("RUNTIME_PROVIDER_IDS");
        for (const literal of PROVIDER_LITERALS) {
          expect(source, `${rel} must not contain ${literal}`).not.toContain(literal);
        }
        expect(source).not.toMatch(/from "\.\/claude-code\.js"/);
        expect(source).not.toMatch(/from "\.\/codex\.js"/);
        continue;
      }

      for (const literal of PROVIDER_LITERALS) {
        // runtime.ts / handler.ts may mention provider concepts in comments;
        // forbid executable string comparisons / imports of concrete handlers.
        expect(source, `${rel} must not import handlers/<provider>`).not.toMatch(
          /from ["'].*handlers\/(claude-code|codex|cursor|grok|kimi-code|opencode|pi)/,
        );
        if (relPosix === "runtime/handler.ts" || relPosix === "runtime/runtime.ts") {
          expect(source).not.toContain(`=== "${literal.replaceAll('"', "").replaceAll("'", "")}"`);
        }
      }
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

  it("keeps web provider surfaces derived from the shared catalog", () => {
    const providersTs = readFileSync(
      join(repoRoot, "packages/web/src/pages/clients/cards/shared/providers.ts"),
      "utf8",
    );
    expect(providersTs).toContain("RUNTIME_PROVIDER_CATALOG");
    expect(providersTs).toContain("enabledRuntimeProviders");
    expect(providersTs).toContain("runtimeProviderInstallCommand");
    // Parallel data tables must not be reintroduced.
    expect(providersTs).not.toMatch(
      /export const PROVIDER_LABEL: Record<RuntimeProvider, string> = \{\s*"claude-code":/,
    );
  });
});
