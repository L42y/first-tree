import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

function layerOf(file: string): "cloud" | "runtime" | "providers" | "root" | null {
  const rel = relative(clientSrc, file).replaceAll("\\", "/");
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
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function resolveLayer(
  fromFile: string,
  spec: string,
): "cloud" | "runtime" | "providers" | "root" | "external" | "unknown" {
  if (spec.startsWith("@first-tree/client/cloud")) return "cloud";
  if (spec.startsWith("@first-tree/client/runtime")) return "runtime";
  if (spec.startsWith("@first-tree/client/providers")) return "providers";
  if (spec === "@first-tree/client" || spec.startsWith("@first-tree/client/observability")) return "root";
  if (!spec.startsWith(".")) return "external";
  const target = join(dirname(fromFile), spec.replace(/\.js$/, ""));
  const candidates = [`${target}.ts`, join(target, "index.ts")];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    return layerOf(c) ?? "unknown";
  }
  return "unknown";
}

describe("client directory production dependency direction", () => {
  it("keeps cloud free of runtime/providers; runtime free of providers; providers free of cloud", () => {
    const violations: string[] = [];
    for (const file of walk(clientSrc)) {
      const from = layerOf(file);
      if (!from || from === "root") continue;
      const source = readFileSync(file, "utf8");
      for (const spec of extractSpecifiers(source)) {
        const to = resolveLayer(file, spec);
        if (to === "external" || to === "unknown" || to === "root") continue;
        const rel = relative(clientSrc, file).replaceAll("\\", "/");
        if (from === "cloud" && (to === "runtime" || to === "providers")) {
          violations.push(`${rel} -> ${spec} (${to})`);
        }
        if (from === "runtime" && to === "providers") {
          violations.push(`${rel} -> ${spec} (${to})`);
        }
        if (from === "providers" && to === "cloud") {
          // allow only through injected seams — production import of cloud is forbidden
          violations.push(`${rel} -> ${spec} (${to})`);
        }
        if (from === "providers" && to === "runtime") {
          // providers may only enter runtime via contracts / provider-support
          if (
            !(
              spec.includes("/runtime/contracts") ||
              spec.includes("/runtime/provider-support") ||
              spec.endsWith("../runtime/contracts.js") ||
              spec.includes("../runtime/provider-support/") ||
              spec.includes("../../runtime/contracts") ||
              spec.includes("../../runtime/provider-support") ||
              spec.includes("../../../runtime/contracts") ||
              spec.includes("../../../runtime/provider-support")
            )
          ) {
            // relative depth variants
            const normalized = spec.replaceAll("\\", "/");
            if (
              !/\/runtime\/contracts(?:\.js)?$/.test(normalized) &&
              !normalized.includes("/runtime/provider-support/")
            ) {
              violations.push(`${rel} -> ${spec} (runtime outside contracts/provider-support)`);
            }
          }
        }
      }
    }
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
});
