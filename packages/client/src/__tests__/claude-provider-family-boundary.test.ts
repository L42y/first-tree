import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");

function escapeForRegex(spec: string): string {
  return spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a real `import`/`export ... from "<spec>"` declaration (covers both
 * a binding import and a re-export-from) whose module specifier is exactly
 * `spec` — anchored to the start of a line so a comment or doc-string merely
 * mentioning the same text cannot satisfy it. `[^;]*` intentionally excludes
 * `;` (not newlines) so multi-line named-import lists
 * (`import {\n  a,\n  b,\n} from "spec";`) still match.
 */
function fromImportOrExportOf(spec: string): RegExp {
  const escaped = escapeForRegex(spec);
  return new RegExp(`^\\s*(?:import|export)\\b[^;]*from\\s*["']${escaped}["']`, "m");
}

/**
 * Matches a bare side-effect `import "<spec>";` (no bindings, no `from`) —
 * the ESM form that runs a module purely for its top-level side effects.
 */
function sideEffectImportOf(spec: string): RegExp {
  const escaped = escapeForRegex(spec);
  return new RegExp(`^\\s*import\\s*["']${escaped}["']`, "m");
}

/** Matches a dynamic `import("<spec>")` / `import('<spec>')` call anywhere in the source. */
function dynamicImportOf(spec: string): RegExp {
  const escaped = escapeForRegex(spec);
  return new RegExp(`import\\(\\s*["']${escaped}["']`);
}

/** Matches a real named import of `name` from the exact module specifier `spec`. */
function namedImportOf(name: string, spec: string): RegExp {
  const escaped = escapeForRegex(spec);
  return new RegExp(`^\\s*import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${escaped}["']`, "m");
}

/**
 * True if `source` references module `spec` through ANY real ESM form: a
 * binding import, a re-export-from, a bare side-effect import, or a dynamic
 * `import()` call. This is the single predicate the "must not depend on X"
 * checks below use, so a forbidden edge cannot sneak back in through a form
 * the guard forgot to check.
 */
function referencesModuleSpecifier(source: string, spec: string): boolean {
  return (
    fromImportOrExportOf(spec).test(source) ||
    sideEffectImportOf(spec).test(source) ||
    dynamicImportOf(spec).test(source)
  );
}

/**
 * Architectural guard for the Claude provider-family split
 * (`handlers/claude/tool-call-processor.ts`, `handlers/claude/mcp-config.ts`,
 * `handlers/claude/sdk-query-options.ts`).
 *
 * The SDK stream handler (`handlers/claude-code.ts`) and the Claude TUI
 * transcript handler (`handlers/claude-code-tui/index.ts`) both consume these
 * modules directly. Before this split, the TUI handler imported them FROM the
 * SDK handler entry point — a reverse dependency that made the TUI handler's
 * load graph include the entire SDK lifecycle module. This guard fails if
 * that reverse dependency ever comes back — as a binding import, a
 * re-export-from, a side-effect import, or a dynamic `import()` — and if the
 * SDK handler entry stops re-exporting the same names (which would silently
 * break any existing internal/package import of them from `claude-code.js`).
 *
 * All checks below match actual `import`/`export`/dynamic-`import()` syntax
 * (anchored to a statement, not a bare substring), so a comment or doc-string
 * mentioning the forbidden/required path cannot flip the assertion either
 * way. The "specifier-matching helpers stay precise" block below proves this
 * directly against synthetic snippets, so the guard's own detection logic
 * does not rest solely on the fact that it happens to pass against current
 * source.
 */
describe("Claude provider-family boundary", () => {
  it("TUI handler depends on the provider-family modules directly, never on the SDK handler entry", () => {
    const tui = readFileSync(join(clientSrc, "handlers/claude-code-tui/index.ts"), "utf8");

    // The reverse dependency this split removes: the TUI handler must never
    // reference its sibling SDK handler entry point again, in any ESM form.
    expect(referencesModuleSpecifier(tui, "../claude-code.js")).toBe(false);

    // It must import the provider-family modules it actually uses via real
    // named-import declarations (not merely mention them in a comment).
    expect(tui).toMatch(namedImportOf("createToolCallProcessor", "../claude/tool-call-processor.js"));
    expect(tui).toMatch(namedImportOf("mapMcpServers", "../claude/mcp-config.js"));
  });

  it("provider-family modules stay self-contained (no import back into either handler, in any ESM form)", () => {
    for (const file of ["tool-call-processor.ts", "mcp-config.ts", "sdk-query-options.ts"]) {
      const source = readFileSync(join(clientSrc, "handlers/claude", file), "utf8");
      for (const spec of ["../claude-code.js", "./claude-code.js", "../../handlers/claude-code.js"]) {
        expect(
          referencesModuleSpecifier(source, spec),
          `${file} must not reference the SDK handler entry (${spec})`,
        ).toBe(false);
      }
      for (const spec of ["../claude-code-tui/index.js", "./claude-code-tui/index.js"]) {
        expect(referencesModuleSpecifier(source, spec), `${file} must not reference the TUI handler (${spec})`).toBe(
          false,
        );
      }
    }
  });

  it("sdk-query-options.ts composes mcp-config.ts rather than re-deriving MCP mapping", () => {
    const source = readFileSync(join(clientSrc, "handlers/claude/sdk-query-options.ts"), "utf8");
    expect(source).toMatch(namedImportOf("mapMcpServers", "./mcp-config.js"));
    expect(source).not.toMatch(/for \(const s of payload\.mcpServers\)/);
  });

  it("the SDK handler entry re-exports every migrated helper/type for backward-compatible imports", () => {
    const source = readFileSync(join(clientSrc, "handlers/claude-code.ts"), "utf8");

    // The three modules stay the actual owners; claude-code.ts is now a thin
    // SDK-lifecycle-only facade that imports and re-exports them.
    expect(source).toMatch(fromImportOrExportOf("./claude/tool-call-processor.js"));
    expect(source).toMatch(fromImportOrExportOf("./claude/mcp-config.js"));
    expect(source).toMatch(fromImportOrExportOf("./claude/sdk-query-options.js"));

    // Every name any existing import site (internal call sites, tests, and —
    // pre-decoupling — the TUI handler) could previously reach via
    // `handlers/claude-code.js` must still resolve from there, via a real
    // `export { ... }` statement (not a mention in prose).
    for (const name of [
      "createToolCallProcessor",
      "treeNodePathOf",
      "ContextTreeBinding",
      "ToolCallProcessor",
      "mapMcpServers",
      "buildClaudeQueryOptions",
      "isSameModelFamily",
      "ClaudeQueryConfigOptions",
    ]) {
      expect(source, `claude-code.ts must still export ${name}`).toMatch(
        new RegExp(`^export\\s*\\{[^}]*\\b${name}\\b`, "m"),
      );
    }

    // The extracted logic itself must not still be defined inline here —
    // only imported/re-exported — so there is exactly one source of truth.
    expect(source).not.toMatch(/^export function createToolCallProcessor/m);
    expect(source).not.toMatch(/^export function mapMcpServers/m);
    expect(source).not.toMatch(/^export function buildClaudeQueryOptions/m);
  });

  it("re-exported runtime helpers are the exact same function references the leaf modules export, not a second implementation", async () => {
    const facade = await import("../handlers/claude-code.js");
    const toolCallProcessor = await import("../handlers/claude/tool-call-processor.js");
    const mcpConfig = await import("../handlers/claude/mcp-config.js");
    const sdkQueryOptions = await import("../handlers/claude/sdk-query-options.js");

    // `export { name } from "./leaf.js"` after `import { name } from "./leaf.js"`
    // re-exports the same binding under ESM semantics; asserting reference
    // identity (not just equal behavior) is what rules out a wrapper or a
    // copy-pasted second implementation living behind the facade — importing
    // the same names from both the facade and each leaf and comparing `toBe`
    // proves it directly, rather than inferring it from source text.
    expect(facade.createToolCallProcessor).toBe(toolCallProcessor.createToolCallProcessor);
    expect(facade.treeNodePathOf).toBe(toolCallProcessor.treeNodePathOf);
    expect(facade.mapMcpServers).toBe(mcpConfig.mapMcpServers);
    expect(facade.buildClaudeQueryOptions).toBe(sdkQueryOptions.buildClaudeQueryOptions);
    expect(facade.isSameModelFamily).toBe(sdkQueryOptions.isSameModelFamily);

    // `ContextTreeBinding`, `ToolCallProcessor`, `ClaudeQueryConfigOptions` are
    // type-only exports erased at runtime — there is no value to assert
    // identity on. `tsc` is the proof for those: every `import type` of them
    // from either the facade or the leaf module must resolve to the same
    // declaration, which the repo-wide typecheck run already exercises.
  });

  describe("specifier-matching helpers stay precise", () => {
    const spec = "../claude-code.js";

    /**
     * Table-driven characterization of `referencesModuleSpecifier()` against
     * every real ESM form that could re-introduce the forbidden dependency,
     * plus the near-miss shapes (comments, doc-strings, string literals, a
     * similar-but-unequal specifier) that must never trip a false positive.
     * This is what proves the detection logic itself — the guard elsewhere
     * in this file only proves today's real source happens to satisfy it.
     */
    const SPECIFIER_CASES: ReadonlyArray<{ label: string; snippet: string; expected: boolean }> = [
      {
        label: "static named import",
        snippet: 'import { createToolCallProcessor } from "../claude-code.js";',
        expected: true,
      },
      { label: "static default import", snippet: 'import ClaudeCode from "../claude-code.js";', expected: true },
      { label: "static namespace import", snippet: 'import * as claudeCode from "../claude-code.js";', expected: true },
      {
        label: "multi-line static named import",
        snippet: 'import {\n  createToolCallProcessor,\n  mapMcpServers,\n} from "../claude-code.js";',
        expected: true,
      },
      {
        label: "bare side-effect import (no bindings, no `from`)",
        snippet: 'import "../claude-code.js";',
        expected: true,
      },
      {
        label: "re-export-from",
        snippet: 'export { createToolCallProcessor } from "../claude-code.js";',
        expected: true,
      },
      {
        label: "dynamic import(), awaited",
        snippet: 'const m = await import("../claude-code.js");',
        expected: true,
      },
      {
        label: "dynamic import(), chained .then()",
        snippet: 'import("../claude-code.js").then((m) => m);',
        expected: true,
      },
      { label: "dynamic import(), single-quoted", snippet: "import('../claude-code.js');", expected: true },
      {
        label: "comment-only mention",
        snippet:
          '// see ../claude-code.js for the pre-split behaviour\nimport { mapMcpServers } from "./mcp-config.js";',
        expected: false,
      },
      {
        label: "doc-string mention",
        snippet: '/**\n * Used to import from "../claude-code.js" before this split.\n */\nexport const x = 1;',
        expected: false,
      },
      {
        label: "string-literal mention",
        snippet: 'const message = "this string contains ../claude-code.js but is not an import";',
        expected: false,
      },
      {
        label: "similar-but-unequal specifier (shares a suffix)",
        snippet: 'import { x } from "../not-claude-code.js";',
        expected: false,
      },
    ];

    it.each(SPECIFIER_CASES)("$label -> referencesModuleSpecifier === $expected", ({ snippet, expected }) => {
      expect(referencesModuleSpecifier(snippet, spec)).toBe(expected);
    });

    it("the side-effect-import case is exactly the regression the guard used to miss: the pre-fix from-anchored matcher alone stays blind to it, and the dynamic-import matcher alone stays blind to it too — only the combinator catches it", () => {
      const sideEffectSnippet = 'import "../claude-code.js";';
      // `fromImportOrExportOf` is the pre-fix matcher (it required a `from`
      // clause): it correctly does NOT see a bare side-effect import, which
      // is exactly why relying on it alone let this reverse-dependency form
      // through undetected before this test file added `sideEffectImportOf`.
      expect(fromImportOrExportOf(spec).test(sideEffectSnippet)).toBe(false);
      expect(dynamicImportOf(spec).test(sideEffectSnippet)).toBe(false);
      // The combined predicate closes the gap.
      expect(referencesModuleSpecifier(sideEffectSnippet, spec)).toBe(true);
    });
  });
});
