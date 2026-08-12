import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Post-bundle channel-home isolation: spawns the **built dist binary**
 * (not source) with a controlled `HOME` env and asserts the resolved
 * `defaultHome()` equals `channelConfig.defaultHome`.
 *
 * Why this test is load-bearing: the previous design relied on the
 * channel-env side-effect setting `process.env.FIRST_TREE_HOME` BEFORE
 * the resolver const evaluated. Source-mode tests passed (lazy load
 * order works in `tsx`), but after tsdown bundled the workspace, ESM
 * hoisted every chunk's top-level evaluation BEFORE the importing
 * module's body — so the resolver const locked to the prod fallback
 * `~/.first-tree`, silently making staging / dev daemons embed
 * `FIRST_TREE_HOME=~/.first-tree` in their service unit files. Three
 * homes collapsed to one. Source-mode tests CAN NOT catch this — only
 * spawning the actual dist binary can.
 *
 * Fix: resolver paths are now functions (lazy env read at call time).
 * This test pins the contract so a future refactor that re-introduces a
 * top-level const (in resolver.ts OR any downstream module that derives
 * a const from `defaultHome()` / `defaultConfigDir()` / `defaultDataDir()`)
 * gets caught.
 *
 * Test infra: builds dist on demand via the root `pnpm build` if it's
 * missing. CI typically runs `pnpm build` before tests so the build
 * is a cached no-op.
 */
const DIST = resolve(__dirname, "../../dist/cli/index.mjs");
const DIST_ROOT = resolve(__dirname, "../../dist");
const REPO_ROOT = resolve(__dirname, "../../../..");
// Private client packages are build-time workspace inputs that tsdown must
// resolve (via each package's `dist` export) and inline into the public CLI
// artifact. They must NOT remain as runtime imports in `apps/cli/dist/**`.
// Cold CI runners historically skip a pre-test `pnpm build`, so ensure the
// private package dist outputs exist before asserting the inlined CLI artifact.
const PRIVATE_CLIENT_DIST_ENTRIES = [
  "packages/cloud-client/dist/index.mjs",
  "packages/client-runtime/dist/index.mjs",
  "packages/client-providers/dist/index.mjs",
] as const;
const PRIVATE_CLIENT_DIST = PRIVATE_CLIENT_DIST_ENTRIES.map((rel) => resolve(REPO_ROOT, rel));
const PRIVATE_CLIENT_SPECIFIER_RE =
  /(?:from|import)\s*\(?\s*["']@first-tree\/(?:cloud-client|client-runtime|client-providers)(?:\/[^"']*)?["']/;

function listDistModules(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".mjs") || entry.endsWith(".js") || entry.endsWith(".cjs")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function assertPrivateClientPackagesInlined(): void {
  if (!existsSync(DIST_ROOT)) {
    throw new Error(`CLI dist root missing: ${DIST_ROOT}`);
  }
  const hits: string[] = [];
  for (const file of listDistModules(DIST_ROOT)) {
    const text = readFileSync(file, "utf8");
    if (PRIVATE_CLIENT_SPECIFIER_RE.test(text)) {
      hits.push(relative(DIST_ROOT, file));
    }
  }
  expect(
    hits,
    `apps/cli/dist must inline private client packages; unresolved workspace specifiers remain in: ${hits.join(", ")}`,
  ).toEqual([]);
}

function ensureDistBuilt(): void {
  if (existsSync(DIST) && PRIVATE_CLIENT_DIST.every((path) => existsSync(path))) {
    assertPrivateClientPackagesInlined();
    return;
  }
  // Full monorepo build via the root `pnpm build` script (= `turbo run
  // build`). Turbo respects per-task `dependsOn` so packages build in
  // topological order — `@first-tree/shared` → private client packages →
  // `first-tree-dev` — and caches keep warm runs sub-second.
  //
  // **cwd: REPO_ROOT is load-bearing**. Without it, `pnpm build` runs
  // apps/cli/package.json's `build` script (CLI-only tsdown) instead of the
  // root's `turbo run build`, leaving private package `dist/` inputs
  // unbuilt so the public CLI cannot resolve/inline them.
  const build = spawnSync("pnpm", ["build"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 300_000,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(`pnpm build failed (status ${build.status ?? "unknown"})`);
  }
  if (!existsSync(DIST)) {
    throw new Error(`build succeeded but ${DIST} still missing`);
  }
  for (const path of PRIVATE_CLIENT_DIST) {
    if (!existsSync(path)) {
      throw new Error(
        `build succeeded but ${path} still missing — root pnpm build may have skipped private client packages`,
      );
    }
  }
  assertPrivateClientPackagesInlined();
}

type HomeInfo = {
  channel: "dev" | "staging" | "prod";
  binName: string;
  packageName: string | null;
  channelDefaultHome: string;
  home: string;
  configDir: string;
  dataDir: string;
  serviceUnitFile: string;
  launchdLabel: string;
  firstTreeHomeEnv: string | null;
};

function spawnHomeInfo(env: NodeJS.ProcessEnv): HomeInfo {
  const res = spawnSync(process.execPath, [DIST, "daemon", "home-info"], {
    encoding: "utf-8",
    timeout: 10_000,
    // Use the merged env exactly — caller controls HOME / FIRST_TREE_HOME
    // / NODE_PATH explicitly.
    env,
  });
  if (res.status !== 0) {
    throw new Error(
      `daemon home-info exited with status ${res.status ?? "unknown"} (signal=${res.signal ?? "none"}). ` +
        `stdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  // home-info prints exactly one line of JSON; tolerate optional
  // trailing newline.
  const line = res.stdout.trim();
  if (!line) throw new Error(`daemon home-info produced no stdout. stderr: ${res.stderr}`);
  return JSON.parse(line) as HomeInfo;
}

describe("post-bundle channel-home isolation", () => {
  let tmpHome: string;

  // CI's test job does not run `pnpm build` before `pnpm test`, so the
  // first call to ensureDistBuilt triggers a full cold-cache turbo
  // build (~30–60s on GitHub runners). vitest's default hook timeout
  // is 10s — way too short. Run once in `beforeAll` (not beforeEach)
  // with an explicit 5-minute budget; subsequent test cases skip the
  // ensureDistBuilt path because dist now exists.
  beforeAll(() => {
    ensureDistBuilt();
  }, 300_000);

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "post-bundle-home-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("inlines private client packages so apps/cli/dist has no unresolved workspace specifiers", () => {
    assertPrivateClientPackagesInlined();
  });

  it("dist binary resolves home to channel default (~/.first-tree-dev for dev channel)", () => {
    // Source tree CHANNEL = "dev" — bundled binary inherits that until CI
    // rewrites build-info.ts for prod / staging publishes. So this test
    // asserts dev channel behaviour: a fresh-env spawn must land in
    // `~/.first-tree-dev`, NOT the prod fallback `~/.first-tree`.
    const env = { ...process.env, HOME: tmpHome } as NodeJS.ProcessEnv;
    // Strip any inherited FIRST_TREE_HOME so the channel default is what
    // gets exercised — not whatever the test runner's parent shell had.
    delete env.FIRST_TREE_HOME;

    const info = spawnHomeInfo(env);

    expect(info.channel).toBe("dev");
    expect(info.binName).toBe("first-tree-dev");
    expect(info.packageName).toBeNull();
    expect(info.channelDefaultHome).toBe(join(tmpHome, ".first-tree-dev"));
    // Critical assertion: defaultHome() returned the SAME path as
    // channelConfig.defaultHome. If a future refactor re-introduces a
    // top-level const in resolver.ts (or any downstream module), this
    // assertion catches it — `home` would lock to `~/.first-tree`
    // (prod fallback) while `channelDefaultHome` stays correct, and the
    // two diverge.
    expect(info.home).toBe(info.channelDefaultHome);
    expect(info.configDir).toBe(join(info.channelDefaultHome, "config"));
    expect(info.dataDir).toBe(join(info.channelDefaultHome, "data"));
    // channel-env.ts wrote FIRST_TREE_HOME from channelConfig.defaultHome
    // — surfaced for diagnostics if this test ever fails.
    expect(info.firstTreeHomeEnv).toBe(info.channelDefaultHome);
  });

  it("respects an explicit FIRST_TREE_HOME override (highest priority)", () => {
    // The channel-env side-effect uses a falsy check, so an externally
    // set FIRST_TREE_HOME wins. This is the escape hatch operators rely
    // on for one-off test sandboxes.
    const overrideHome = join(tmpHome, "custom-home-xyz");
    const env = { ...process.env, HOME: tmpHome, FIRST_TREE_HOME: overrideHome } as NodeJS.ProcessEnv;

    const info = spawnHomeInfo(env);

    expect(info.firstTreeHomeEnv).toBe(overrideHome);
    expect(info.home).toBe(overrideHome);
    expect(info.configDir).toBe(join(overrideHome, "config"));
    expect(info.dataDir).toBe(join(overrideHome, "data"));
    // channelConfig.defaultHome is unaffected by env — it's the binary's
    // identity, not a user setting. Stays at ~/.first-tree-dev.
    expect(info.channelDefaultHome).toBe(join(tmpHome, ".first-tree-dev"));
  });

  it("service unit / launchd label come from the channel, not the home path", () => {
    // FIRST_TREE_HOME override does NOT rename the service unit — that
    // would let an operator's one-off test sandbox accidentally collide
    // with the channel's real systemd unit. Service identity is bound
    // to the channel.
    const env = {
      ...process.env,
      HOME: tmpHome,
      FIRST_TREE_HOME: join(tmpHome, "weird-path"),
    } as NodeJS.ProcessEnv;

    const info = spawnHomeInfo(env);

    expect(info.serviceUnitFile).toBe("first-tree-dev.service");
    expect(info.launchdLabel).toBe("first-tree-dev");
  });
});
