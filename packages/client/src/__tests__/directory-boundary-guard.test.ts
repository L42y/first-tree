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
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extractModuleReferences } from "./module-reference-extract.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");

type Layer = "cloud" | "runtime" | "providers" | "root";
type ResolvedTarget =
  | { kind: "layer"; layer: Layer; resolvedRel: string | null }
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

/** Authoritative provider→Runtime seams (matches provider-boundary-guard). */
const ALLOWED_PROVIDER_RUNTIME_SEAMS = new Set(["runtime/contracts.ts", "runtime/provider-support/index.ts"]);

const ALLOWED_PROVIDER_RUNTIME_PACKAGE_SPECS = new Set([
  "@first-tree/client/runtime/contracts",
  "@first-tree/client/runtime/provider-support",
]);

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

/** Resolve a relative specifier to an existing `.ts` file using normalized path traversal. */
function resolveRelativeTarget(fromFile: string, spec: string): string | null {
  const stripped = spec.replace(/\.js$/, "");
  const base = normalize(join(dirname(fromFile), stripped));
  const candidates = [`${base}.ts`, join(base, "index.ts")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function packageSpecLayer(spec: string): Layer | null {
  if (spec === "@first-tree/client") return "root";
  if (spec.startsWith("@first-tree/client/cloud")) return "cloud";
  if (spec.startsWith("@first-tree/client/runtime")) return "runtime";
  if (spec.startsWith("@first-tree/client/providers")) return "providers";
  // Compatibility export — same ownership as cloud/observability.
  if (spec.startsWith("@first-tree/client/observability")) return "cloud";
  return null;
}

function resolveImport(srcRoot: string, fromFile: string, spec: string): ResolvedTarget {
  const pkgLayer = packageSpecLayer(spec);
  if (pkgLayer) {
    let resolvedRel: string | null = null;
    if (spec === "@first-tree/client/runtime/contracts") resolvedRel = "runtime/contracts.ts";
    else if (
      spec === "@first-tree/client/runtime/provider-support" ||
      spec === "@first-tree/client/runtime/provider-support/index"
    ) {
      resolvedRel = "runtime/provider-support/index.ts";
    } else if (spec === "@first-tree/client") resolvedRel = "index.ts";
    else if (spec.startsWith("@first-tree/client/observability")) {
      resolvedRel = "cloud/observability/index.ts";
    }
    return { kind: "layer", layer: pkgLayer, resolvedRel };
  }
  if (!spec.startsWith(".")) return { kind: "external" };

  const fromRel = relative(srcRoot, fromFile).replaceAll("\\", "/");
  const allowKey = `${fromRel} -> ${spec}`;
  if (RELATIVE_NON_CODE_ASSET_ALLOWLIST.has(allowKey)) return { kind: "asset" };

  const resolved = resolveRelativeTarget(fromFile, spec);
  if (!resolved) return { kind: "unresolved" };
  const layer = layerOf(srcRoot, resolved);
  if (!layer) return { kind: "unresolved" };
  return {
    kind: "layer",
    layer,
    resolvedRel: relative(srcRoot, resolved).replaceAll("\\", "/"),
  };
}

function isAllowedProviderRuntimeSeam(spec: string, resolvedRel: string | null): boolean {
  if (ALLOWED_PROVIDER_RUNTIME_PACKAGE_SPECS.has(spec)) return true;
  if (resolvedRel && ALLOWED_PROVIDER_RUNTIME_SEAMS.has(resolvedRel)) return true;
  return false;
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
    const refs = extractModuleReferences(source);
    if (refs.hasUnresolvableModuleReference) {
      violations.push(`${rel}: unclassifiable/non-literal module reference`);
    }

    for (const spec of refs.literalSpecifiers) {
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
      if (from === "providers" && to.layer === "runtime") {
        if (!isAllowedProviderRuntimeSeam(spec, to.resolvedRel)) {
          violations.push(
            `${rel} -> ${spec} (runtime outside contracts/provider-support index; resolved=${to.resolvedRel ?? "n/a"})`,
          );
        }
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
  mkdirSync(join(src, "runtime", "provider-support"), { recursive: true });
  mkdirSync(join(src, "providers"), { recursive: true });
  writeFileSync(join(src, "index.ts"), `export * from "./cloud/index.js";\n`);
  writeFileSync(join(src, "cloud", "index.ts"), `export const cloud = true;\n`);
  writeFileSync(join(src, "runtime", "index.ts"), `export const runtime = true;\n`);
  writeFileSync(join(src, "runtime", "contracts.ts"), `export type Contract = string;\n`);
  writeFileSync(join(src, "runtime", "session-manager.ts"), `export class SessionManager {}\n`);
  writeFileSync(join(src, "runtime", "provider-support", "index.ts"), `export const support = true;\n`);
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

  it("negative fixture: non-literal dynamic import fails closed", () => {
    const src = makeFixtureSrc();
    writeFileSync(
      join(src, "providers", "dyn.ts"),
      `const target = "../runtime/session-manager.js";\nexport async function load() {\n  return import(target);\n}\n`,
    );
    const violations = collectDirectoryBoundaryViolations(src);
    expect(violations.some((v) => v.includes("providers/dyn.ts") && v.includes("unclassifiable/non-literal"))).toBe(
      true,
    );
  });

  it("negative fixture: ImportEquals require and createRequire binder loads fail closed when targeting Runtime", () => {
    const src = makeFixtureSrc();
    writeFileSync(
      join(src, "providers", "equals.ts"),
      `import Session = require("../runtime/session-manager.js");\nexport { Session };\n`,
    );
    writeFileSync(
      join(src, "providers", "cjs.ts"),
      `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const Session = req("../runtime/session-manager.js");\n`,
    );
    const violations = collectDirectoryBoundaryViolations(src);
    expect(
      violations.some(
        (v) => v.includes("providers/equals.ts") && v.includes("runtime outside contracts/provider-support"),
      ),
    ).toBe(true);
    expect(
      violations.some(
        (v) => v.includes("providers/cjs.ts") && v.includes("runtime outside contracts/provider-support"),
      ),
    ).toBe(true);
  });

  it("negative fixture: provider-support/../session-manager traversal fails from resolved target", () => {
    const src = makeFixtureSrc();
    writeFileSync(
      join(src, "providers", "traverse.ts"),
      `import { SessionManager } from "../runtime/provider-support/../session-manager.js";\nexport { SessionManager };\n`,
    );
    const violations = collectDirectoryBoundaryViolations(src);
    expect(
      violations.some(
        (v) =>
          v.includes("providers/traverse.ts") &&
          v.includes("runtime outside contracts/provider-support") &&
          v.includes("resolved=runtime/session-manager.ts"),
      ),
    ).toBe(true);
  });

  it("negative fixture: string-key namespace-destructured createRequire alias fails closed via production collector", () => {
    const src = makeFixtureSrc();
    // Exact baixiaohang reproducer: quoted property key (not identifier-key).
    const source = `import * as nodeModule from "node:module";
const { "createRequire": makeRequire } = nodeModule;
const load = makeRequire(import.meta.url);
export const Session = load("../runtime/session-manager.js");
`;
    writeFileSync(join(src, "providers", "destructure-cjs.ts"), source);

    // Extractor must classify the binder load (not silently skip, not only
    // fall through to a generic unresolvable flag without recording the edge).
    const refs = extractModuleReferences(source);
    expect(refs.hasUnresolvableModuleReference).toBe(false);
    expect(refs.literalSpecifiers).toContain("node:module");
    expect(refs.literalSpecifiers).toContain("../runtime/session-manager.js");

    const violations = collectDirectoryBoundaryViolations(src);
    expect(
      violations.some(
        (v) =>
          v.includes("providers/destructure-cjs.ts") &&
          v.includes("runtime outside contracts/provider-support") &&
          v.includes("resolved=runtime/session-manager.ts"),
      ),
    ).toBe(true);
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
