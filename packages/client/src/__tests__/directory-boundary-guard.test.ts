import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");

type Layer = "cloud" | "runtime" | "providers" | "root";
type ResolvedTarget =
  | { kind: "layer"; layer: Layer }
  | { kind: "external" }
  | { kind: "unresolved" }
  | { kind: "asset" };

/**
 * Narrow allowlist for relative imports that intentionally target non-TypeScript
 * assets (templates, JSON, markdown, etc.). Empty today — add only with a
 * documented production path + reason; never use this to silence missing `.ts`
 * modules.
 */
const RELATIVE_NON_CODE_ASSET_ALLOWLIST: ReadonlySet<string> = new Set([]);

function walkProductionTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkProductionTs(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

function layerOf(srcRoot: string, file: string): Layer | null {
  const rel = relative(srcRoot, file).replaceAll("\\", "/");
  if (rel.startsWith("cloud/")) return "cloud";
  if (rel.startsWith("runtime/")) return "runtime";
  if (rel.startsWith("providers/")) return "providers";
  if (rel === "index.ts") return "root";
  return null;
}

function extractSpecifiers(source: string): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    } else if (ts.isImportTypeNode(node) && node.argument && ts.isLiteralTypeNode(node.argument)) {
      const lit = node.argument.literal;
      if (ts.isStringLiteralLike(lit)) out.push(lit.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function resolveRelativeTarget(fromFile: string, spec: string): string | null {
  const stripped = spec.replace(/\.js$/, "");
  const base = join(dirname(fromFile), stripped);
  const candidates = [`${base}.ts`, join(base, "index.ts")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveImport(srcRoot: string, fromFile: string, spec: string): ResolvedTarget {
  if (spec === "@first-tree/client") return { kind: "layer", layer: "root" };
  if (spec.startsWith("@first-tree/client/cloud")) return { kind: "layer", layer: "cloud" };
  if (spec.startsWith("@first-tree/client/runtime")) return { kind: "layer", layer: "runtime" };
  if (spec.startsWith("@first-tree/client/providers")) return { kind: "layer", layer: "providers" };
  // Compatibility export — same ownership as cloud/observability.
  if (spec.startsWith("@first-tree/client/observability")) return { kind: "layer", layer: "cloud" };
  if (!spec.startsWith(".")) return { kind: "external" };

  const fromRel = relative(srcRoot, fromFile).replaceAll("\\", "/");
  const allowKey = `${fromRel} -> ${spec}`;
  if (RELATIVE_NON_CODE_ASSET_ALLOWLIST.has(allowKey)) return { kind: "asset" };

  const resolved = resolveRelativeTarget(fromFile, spec);
  if (!resolved) return { kind: "unresolved" };
  const layer = layerOf(srcRoot, resolved);
  if (!layer) return { kind: "unresolved" };
  return { kind: "layer", layer };
}

function isContractsOrProviderSupport(spec: string): boolean {
  const normalized = spec.replaceAll("\\", "/");
  return (
    /\/runtime\/contracts(?:\.js)?$/.test(normalized) ||
    normalized.includes("/runtime/provider-support/") ||
    normalized.endsWith("/runtime/provider-support") ||
    normalized.endsWith("/runtime/provider-support.js")
  );
}

function collectDirectoryBoundaryViolations(srcRoot: string): string[] {
  const violations: string[] = [];
  for (const file of walkProductionTs(srcRoot)) {
    const from = layerOf(srcRoot, file);
    const rel = relative(srcRoot, file).replaceAll("\\", "/");
    if (!from) {
      violations.push(`${rel}: production .ts outside cloud|runtime|providers (only src/index.ts is allowed at root)`);
      continue;
    }

    const source = readFileSync(file, "utf8");
    for (const spec of extractSpecifiers(source)) {
      const to = resolveImport(srcRoot, file, spec);

      if (to.kind === "external" || to.kind === "asset") continue;

      if (to.kind === "unresolved") {
        violations.push(`${rel} -> ${spec} (unresolved relative TypeScript module)`);
        continue;
      }

      // Composition barrel may import every layer; layers must not import the barrel.
      if (from === "root") continue;

      if (to.layer === "root") {
        violations.push(`${rel} -> ${spec} (root Client barrel bypass)`);
        continue;
      }

      if (from === "cloud" && (to.layer === "runtime" || to.layer === "providers")) {
        violations.push(`${rel} -> ${spec} (${to.layer})`);
      }
      if (from === "runtime" && to.layer === "providers") {
        violations.push(`${rel} -> ${spec} (${to.layer})`);
      }
      if (from === "providers" && to.layer === "cloud") {
        violations.push(`${rel} -> ${spec} (${to.layer})`);
      }
      if (from === "providers" && to.layer === "runtime" && !isContractsOrProviderSupport(spec)) {
        violations.push(`${rel} -> ${spec} (runtime outside contracts/provider-support)`);
      }
    }
  }
  return violations;
}

const fixtureRoots: string[] = [];

afterEach(() => {
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureSrc(): string {
  const root = mkdtempSync(join(tmpdir(), "client-dir-boundary-"));
  fixtureRoots.push(root);
  const src = join(root, "src");
  mkdirSync(join(src, "cloud"), { recursive: true });
  mkdirSync(join(src, "runtime"), { recursive: true });
  mkdirSync(join(src, "providers"), { recursive: true });
  writeFileSync(join(src, "index.ts"), `export * from "./cloud/index.js";\n`);
  writeFileSync(join(src, "cloud", "index.ts"), `export const cloud = true;\n`);
  writeFileSync(join(src, "runtime", "index.ts"), `export const runtime = true;\n`);
  writeFileSync(join(src, "providers", "index.ts"), `export const providers = true;\n`);
  return src;
}

describe("client directory production dependency direction", () => {
  it("keeps every production .ts inside cloud|runtime|providers or the root composition barrel", () => {
    const unclassified: string[] = [];
    for (const file of walkProductionTs(clientSrc)) {
      if (!layerOf(clientSrc, file)) {
        unclassified.push(relative(clientSrc, file).replaceAll("\\", "/"));
      }
    }
    expect(unclassified, unclassified.join("\n")).toEqual([]);
  });

  it("keeps cloud free of runtime/providers; runtime free of providers; providers free of cloud; no root-barrel bypass; no unresolved relatives", () => {
    const violations = collectDirectoryBoundaryViolations(clientSrc);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("exposes the directory subpath export surface from package.json", () => {
    const pkg = JSON.parse(readFileSync(join(clientSrc, "..", "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    for (const key of [
      ".",
      "./cloud",
      "./runtime",
      "./runtime/contracts",
      "./runtime/provider-support",
      "./providers",
      "./observability",
    ]) {
      expect(pkg.exports?.[key], key).toBeTruthy();
    }
  });

  it("negative fixture: unclassified production .ts at src/ fails closed", () => {
    const src = makeFixtureSrc();
    writeFileSync(join(src, "orphan.ts"), `export const orphan = true;\n`);
    const violations = collectDirectoryBoundaryViolations(src);
    expect(violations.some((v) => v.includes("orphan.ts") && v.includes("outside cloud|runtime|providers"))).toBe(true);
  });

  it("negative fixture: layer import/re-export/dynamic-import of root Client barrel fails closed", () => {
    const src = makeFixtureSrc();
    writeFileSync(
      join(src, "cloud", "bypass.ts"),
      `import { something } from "@first-tree/client";\nexport const x = something;\n`,
    );
    writeFileSync(join(src, "runtime", "bypass-relative.ts"), `export { cloud } from "../index.js";\n`);
    writeFileSync(
      join(src, "providers", "bypass-dynamic.ts"),
      `export async function load() {\n  return import("@first-tree/client");\n}\n`,
    );
    const violations = collectDirectoryBoundaryViolations(src);
    expect(violations.some((v) => v.includes("cloud/bypass.ts") && v.includes("root Client barrel bypass"))).toBe(true);
    expect(
      violations.some((v) => v.includes("runtime/bypass-relative.ts") && v.includes("root Client barrel bypass")),
    ).toBe(true);
    expect(
      violations.some((v) => v.includes("providers/bypass-dynamic.ts") && v.includes("root Client barrel bypass")),
    ).toBe(true);
  });

  it("negative fixture: observability compatibility path is cloud ownership, not a skipped root barrel", () => {
    const src = makeFixtureSrc();
    writeFileSync(
      join(src, "providers", "obs.ts"),
      `import { createLogger } from "@first-tree/client/observability";\nexport const log = createLogger;\n`,
    );
    const violations = collectDirectoryBoundaryViolations(src);
    expect(violations.some((v) => v.includes("providers/obs.ts") && v.includes("(cloud)"))).toBe(true);
    expect(violations.some((v) => v.includes("providers/obs.ts") && v.includes("root Client barrel bypass"))).toBe(
      false,
    );
  });

  it("negative fixture: unresolved relative TypeScript module fails closed; external packages stay allowed", () => {
    const src = makeFixtureSrc();
    writeFileSync(join(src, "providers", "missing.ts"), `import { missing } from "./does-not-exist.js";\n`);
    writeFileSync(join(src, "cloud", "external.ts"), `import { z } from "zod";\nexport type Z = typeof z;\n`);
    const violations = collectDirectoryBoundaryViolations(src);
    expect(
      violations.some((v) => v.includes("providers/missing.ts") && v.includes("unresolved relative TypeScript module")),
    ).toBe(true);
    expect(violations.some((v) => v.includes("cloud/external.ts"))).toBe(false);
  });

  it("negative fixture: does not mutate the real packages/client production tree", () => {
    const before = walkProductionTs(clientSrc)
      .map((f) => relative(clientSrc, f).replaceAll("\\", "/"))
      .sort();
    const src = makeFixtureSrc();
    writeFileSync(join(src, "stray.ts"), `export {};\n`);
    collectDirectoryBoundaryViolations(src);
    const after = walkProductionTs(clientSrc)
      .map((f) => relative(clientSrc, f).replaceAll("\\", "/"))
      .sort();
    expect(after).toEqual(before);
    expect(existsSync(join(clientSrc, "stray.ts"))).toBe(false);
    expect(existsSync(join(clientSrc, "orphan.ts"))).toBe(false);
  });
});
