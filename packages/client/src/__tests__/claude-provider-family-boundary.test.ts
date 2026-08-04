import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");

/**
 * Matches a real `import`/`export ... from "<spec>"` declaration whose module
 * specifier is exactly `spec` — anchored to the start of a line so a comment
 * or doc-string merely mentioning the same text cannot satisfy it. `[^;]*`
 * intentionally excludes `;` (not newlines) so multi-line named-import lists
 * (`import {\n  a,\n  b,\n} from "spec";`) still match.
 */
function staticImportOrExportOf(spec: string): RegExp {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:import|export)\\b[^;]*from\\s*["']${escaped}["']`, "m");
}

/** Matches a dynamic `import("<spec>")` / `import('<spec>')` call anywhere in the source. */
function dynamicImportOf(spec: string): RegExp {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`import\\(\\s*["']${escaped}["']`);
}

/** Matches a real named import of `name` from the exact module specifier `spec`. */
function namedImportOf(name: string, spec: string): RegExp {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${escaped}["']`, "m");
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
 * that reverse dependency ever comes back (static or dynamic), and if the SDK
 * handler entry stops re-exporting the same names (which would silently
 * break any existing internal/package import of them from `claude-code.js`).
 *
 * All checks below match actual `import`/`export`/dynamic-`import()` syntax
 * (anchored to a statement, not a bare substring), so a comment or doc-string
 * mentioning the forbidden/required path cannot flip the assertion either way.
 */
describe("Claude provider-family boundary", () => {
  it("TUI handler depends on the provider-family modules directly, never on the SDK handler entry", () => {
    const tui = readFileSync(join(clientSrc, "handlers/claude-code-tui/index.ts"), "utf8");

    // The reverse dependency this split removes: the TUI handler must never
    // import from its sibling SDK handler entry point again, statically or
    // dynamically.
    expect(tui).not.toMatch(staticImportOrExportOf("../claude-code.js"));
    expect(tui).not.toMatch(dynamicImportOf("../claude-code.js"));

    // It must import the provider-family modules it actually uses via real
    // named-import declarations (not merely mention them in a comment).
    expect(tui).toMatch(namedImportOf("createToolCallProcessor", "../claude/tool-call-processor.js"));
    expect(tui).toMatch(namedImportOf("mapMcpServers", "../claude/mcp-config.js"));
  });

  it("provider-family modules stay self-contained (no static or dynamic import back into either handler)", () => {
    for (const file of ["tool-call-processor.ts", "mcp-config.ts", "sdk-query-options.ts"]) {
      const source = readFileSync(join(clientSrc, "handlers/claude", file), "utf8");
      for (const spec of ["../claude-code.js", "./claude-code.js", "../../handlers/claude-code.js"]) {
        expect(source, `${file} must not import the SDK handler entry (${spec})`).not.toMatch(
          staticImportOrExportOf(spec),
        );
        expect(source, `${file} must not dynamically import the SDK handler entry (${spec})`).not.toMatch(
          dynamicImportOf(spec),
        );
      }
      for (const spec of ["../claude-code-tui/index.js", "./claude-code-tui/index.js"]) {
        expect(source, `${file} must not import the TUI handler (${spec})`).not.toMatch(staticImportOrExportOf(spec));
        expect(source, `${file} must not dynamically import the TUI handler (${spec})`).not.toMatch(
          dynamicImportOf(spec),
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
    expect(source).toMatch(staticImportOrExportOf("./claude/tool-call-processor.js"));
    expect(source).toMatch(staticImportOrExportOf("./claude/mcp-config.js"));
    expect(source).toMatch(staticImportOrExportOf("./claude/sdk-query-options.js"));

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
    // copy-pasted second implementation living behind the facade.
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
});
