import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliRoot = join(repoRoot, "apps", "cli");
const clientRoot = join(repoRoot, "packages", "client");
const canonicalPolicyPath = join(repoRoot, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md");
const canonicalWriteRoutingPath = join(
  repoRoot,
  "packages",
  "client",
  "src",
  "runtime",
  "assets",
  "context-tree-write-routing.md",
);
const smokeEntryName = "context-policy-runtime-smoke-entry.mjs";
const roots: string[] = [];

type BuiltBriefingRuntime = {
  buildAgentBriefing: (options: {
    identity: {
      agentId: string;
      inboxId: string;
      displayName: string;
      type: "agent";
      visibility: "organization";
      delegateMention: null;
      metadata: Record<string, never>;
    };
    payload: null;
    workspacePath: string;
    sourceRepos: [];
    contextTreePath: string | null;
  }) => string;
  readCanonicalContextTreePolicy: () => string;
  readCanonicalContextTreeWriteRouting: () => string;
  resolveCanonicalContextTreePolicyPath: () => string;
  resolveCanonicalContextTreeWriteRoutingPath: () => string;
  setCliBinding: (binding: { binName: string; packageName: string }) => void;
};

let builtCli: BuiltBriefingRuntime;
let builtClient: BuiltBriefingRuntime;
const cliEntryDir = join(cliRoot, "dist", "cli");

function buildPrivateRuntimeEntry(outDir: string): void {
  execFileSync(
    "pnpm",
    [
      "exec",
      "tsdown",
      "tests/fixtures/context-policy-runtime-smoke-entry.ts",
      "--format",
      "esm",
      "--no-dts",
      "--no-clean",
      "--out-dir",
      outDir,
      "--logLevel",
      "error",
    ],
    {
      cwd: cliRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}

beforeAll(async () => {
  execFileSync("pnpm", ["run", "build"], {
    cwd: clientRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  buildPrivateRuntimeEntry(join(clientRoot, "dist"));
  builtClient = (await import(
    `${pathToFileURL(join(clientRoot, "dist", smokeEntryName)).href}?built-policy-smoke`
  )) as BuiltBriefingRuntime;
  execFileSync("pnpm", ["run", "build"], {
    cwd: cliRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  buildPrivateRuntimeEntry(cliEntryDir);
  builtCli = (await import(
    `${pathToFileURL(join(cliEntryDir, smokeEntryName)).href}?built-policy-smoke`
  )) as BuiltBriefingRuntime;
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function assertRuntimeEmbedsCanonicalPolicy(runtime: BuiltBriefingRuntime): void {
  runtime.setCliBinding({ binName: "first-tree", packageName: "first-tree" });
  const canonical = readFileSync(canonicalPolicyPath, "utf8");
  const canonicalWriteRouting = readFileSync(canonicalWriteRoutingPath, "utf8").trim();
  expect(runtime.readCanonicalContextTreePolicy()).toBe(canonical);
  expect(runtime.readCanonicalContextTreeWriteRouting()).toBe(canonicalWriteRouting);
  expect(runtime.resolveCanonicalContextTreePolicyPath()).toMatch(/runtime-assets[/\\]context-tree-policy\.md$/u);
  expect(runtime.resolveCanonicalContextTreeWriteRoutingPath()).toMatch(
    /runtime-assets[/\\]context-tree-write-routing\.md$/u,
  );
  const briefing = runtime.buildAgentBriefing({
    identity: {
      agentId: "agent-runtime-smoke",
      inboxId: "inbox-runtime-smoke",
      displayName: "Runtime Smoke",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    payload: null,
    workspacePath: "/tmp/runtime-smoke-workspace",
    sourceRepos: [],
    contextTreePath: "/tmp/runtime-smoke-context-tree",
  });
  expect(briefing).toContain(canonical);
  expect(briefing.split(canonical)).toHaveLength(2);
  expect(briefing).toContain(canonicalWriteRouting);
  expect(briefing.split(canonicalWriteRouting)).toHaveLength(2);
}

describe("built package CLI", () => {
  it("starts the built package CLI with its external native lock addon", () => {
    const packageJson = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { version: string };
    const output = execFileSync(process.execPath, [join(cliEntryDir, "index.mjs"), "--version"], {
      cwd: cliRoot,
      encoding: "utf8",
    });

    expect(output.trim()).toBe(packageJson.version);
  });
});

describe("canonical Policy runtime layouts", () => {
  it("does not expose Managed briefing internals from public package entries", async () => {
    const [clientEntry, cliEntry] = await Promise.all([
      import(`${pathToFileURL(join(clientRoot, "dist", "index.mjs")).href}?public-api-smoke`),
      import(`${pathToFileURL(join(cliRoot, "dist", "index.mjs")).href}?public-api-smoke`),
    ]);

    for (const entry of [clientEntry, cliEntry]) {
      expect(entry).not.toHaveProperty("buildAgentBriefing");
      expect(entry).not.toHaveProperty("readCanonicalContextTreePolicy");
      expect(entry).not.toHaveProperty("resolveCanonicalContextTreePolicyPath");
    }
    expect(clientEntry).toHaveProperty("readCanonicalContextTreeWriteRouting");
    expect(cliEntry).not.toHaveProperty("readCanonicalContextTreeWriteRouting");
    expect(cliEntry).not.toHaveProperty("setCliBinding");
  });

  it("builds a Managed briefing from the actual @first-tree/client-runtime dist layout", () => {
    assertRuntimeEmbedsCanonicalPolicy(builtClient);
  });

  it("builds a Managed briefing from beside the actual dist/cli entry", () => {
    expect(existsSync(join(cliEntryDir, "index.mjs"))).toBe(true);
    assertRuntimeEmbedsCanonicalPolicy(builtCli);
  });

  it("builds a Managed briefing after relocating the real CLI dist into portable app/", async () => {
    const portableRoot = mkdtempSync(join(cliRoot, ".context-policy-portable-"));
    roots.push(portableRoot);
    const appRoot = join(portableRoot, "app");
    cpSync(join(cliRoot, "dist"), appRoot, { recursive: true });
    expect(existsSync(join(appRoot, "cli", "index.mjs"))).toBe(true);

    const portableRuntime = (await import(
      `${pathToFileURL(join(appRoot, "cli", smokeEntryName)).href}?portable-policy-smoke`
    )) as BuiltBriefingRuntime;
    assertRuntimeEmbedsCanonicalPolicy(portableRuntime);
  });
});
