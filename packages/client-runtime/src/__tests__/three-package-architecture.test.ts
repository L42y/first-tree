import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTs(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function productionImports(pkgSrc: string): string[] {
  const files = walkTs(pkgSrc);
  const imports: string[] = [];
  const re = /from\s+["']([^"']+)["']/g;
  for (const file of files) {
    // skip nested __tests__ already skipped; also skip *.test.ts colocated
    if (file.includes(`${join("src", "__tests__")}${join("/", "")}`) || file.includes("/__tests__/")) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) {
      imports.push(`${relative(repoRoot, file)}:${m[1]}`);
    }
  }
  return imports;
}

describe("S4 three-package production dependency direction", () => {
  it("keeps all three internal manifests private and removes @first-tree/client", () => {
    for (const name of ["cloud-client", "client-runtime", "client-providers"]) {
      const pkg = JSON.parse(readFileSync(join(repoRoot, "packages", name, "package.json"), "utf8")) as {
        name: string;
        private?: boolean;
      };
      expect(pkg.private).toBe(true);
      expect(pkg.name).toBe(`@first-tree/${name}`);
    }
    expect(() => readFileSync(join(repoRoot, "packages/client/package.json"), "utf8")).toThrow();
  });

  it("cloud-client production imports neither runtime nor providers", () => {
    const imports = productionImports(join(repoRoot, "packages/cloud-client/src"));
    for (const entry of imports) {
      expect(entry).not.toMatch(/@first-tree\/client-runtime/);
      expect(entry).not.toMatch(/@first-tree\/client-providers/);
      expect(entry).not.toMatch(/@first-tree\/client"/);
    }
  });

  it("client-runtime production imports no providers", () => {
    const imports = productionImports(join(repoRoot, "packages/client-runtime/src"));
    for (const entry of imports) {
      expect(entry).not.toMatch(/@first-tree\/client-providers/);
      expect(entry).not.toMatch(/\/providers\//);
    }
  });

  it("client-providers production imports runtime only via contracts/provider-support and never cloud-client", () => {
    const imports = productionImports(join(repoRoot, "packages/client-providers/src"));
    for (const entry of imports) {
      const spec = entry.split(":").slice(1).join(":");
      expect(spec).not.toMatch(/@first-tree\/cloud-client/);
      expect(spec).not.toMatch(/@first-tree\/client"/);
      if (spec.startsWith("@first-tree/client-runtime")) {
        expect(
          spec === "@first-tree/client-runtime/contracts" || spec === "@first-tree/client-runtime/provider-support",
        ).toBe(true);
      }
    }
  });

  it("no live production import uses @first-tree/client", () => {
    for (const pkg of ["cloud-client", "client-runtime", "client-providers"]) {
      const imports = productionImports(join(repoRoot, "packages", pkg, "src"));
      for (const entry of imports) {
        expect(entry).not.toMatch(/@first-tree\/client"/);
        expect(entry).not.toMatch(/@first-tree\/client\//);
      }
    }
  });

  it("public CLI keeps private client packages as workspace:devDependencies only", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const privateClientPackages = [
      "@first-tree/cloud-client",
      "@first-tree/client-runtime",
      "@first-tree/client-providers",
    ] as const;
    for (const name of privateClientPackages) {
      expect(pkg.dependencies?.[name]).toBeUndefined();
      expect(pkg.devDependencies?.[name]).toBe("workspace:*");
    }
  });
});
