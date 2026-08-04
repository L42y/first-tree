import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");

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
 * that reverse dependency ever comes back, and if the SDK handler entry stops
 * re-exporting the same names (which would silently break any existing
 * internal/package import of them from `claude-code.js`).
 */
describe("Claude provider-family boundary", () => {
  it("TUI handler depends on the provider-family modules directly, never on the SDK handler entry", () => {
    const tui = readFileSync(join(clientSrc, "handlers/claude-code-tui/index.ts"), "utf8");

    // The reverse dependency this split removes: the TUI handler must never
    // import from its sibling SDK handler entry point again.
    expect(tui).not.toMatch(/from ["']\.\.\/claude-code\.js["']/);

    // It must import the provider-family modules it actually uses.
    expect(tui).toMatch(/createToolCallProcessor.*from ["']\.\.\/claude\/tool-call-processor\.js["']/);
    expect(tui).toMatch(/mapMcpServers.*from ["']\.\.\/claude\/mcp-config\.js["']/);
  });

  it("provider-family modules stay self-contained (no import back into either handler)", () => {
    for (const file of ["tool-call-processor.ts", "mcp-config.ts", "sdk-query-options.ts"]) {
      const source = readFileSync(join(clientSrc, "handlers/claude", file), "utf8");
      expect(source, `${file} must not import the SDK handler entry`).not.toMatch(/from ["'].*\/claude-code\.js["']/);
      expect(source, `${file} must not import the TUI handler`).not.toMatch(
        /from ["'].*claude-code-tui\/index\.js["']/,
      );
    }
  });

  it("sdk-query-options.ts composes mcp-config.ts rather than re-deriving MCP mapping", () => {
    const source = readFileSync(join(clientSrc, "handlers/claude/sdk-query-options.ts"), "utf8");
    expect(source).toContain('from "./mcp-config.js"');
    expect(source).not.toMatch(/for \(const s of payload\.mcpServers\)/);
  });

  it("the SDK handler entry re-exports every migrated helper/type for backward-compatible imports", () => {
    const source = readFileSync(join(clientSrc, "handlers/claude-code.ts"), "utf8");

    // The three modules stay the actual owners; claude-code.ts is now a thin
    // SDK-lifecycle-only facade that imports and re-exports them.
    expect(source).toContain('from "./claude/tool-call-processor.js"');
    expect(source).toContain('from "./claude/mcp-config.js"');
    expect(source).toContain('from "./claude/sdk-query-options.js"');

    // Every name any existing import site (internal call sites, tests, and —
    // pre-decoupling — the TUI handler) could previously reach via
    // `handlers/claude-code.js` must still resolve from there.
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
      expect(source, `claude-code.ts must still export ${name}`).toMatch(new RegExp(`export \\{[^}]*\\b${name}\\b`));
    }

    // The extracted logic itself must not still be defined inline here —
    // only imported/re-exported — so there is exactly one source of truth.
    expect(source).not.toMatch(/^export function createToolCallProcessor/m);
    expect(source).not.toMatch(/^export function mapMcpServers/m);
    expect(source).not.toMatch(/^export function buildClaudeQueryOptions/m);
  });
});
