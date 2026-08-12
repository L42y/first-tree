import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeProvider, RuntimeReadinessConfig, RuntimeReadinessError } from "@first-tree/shared";
import { type ClaudeExecutableAuthority, createClaudeExecutableAuthority } from "./claude/executable.js";
import { verifyClaudeCodeReadiness } from "./claude/readiness.js";
import { resolveCodexRuntimeBinary } from "./codex/capability.js";
import { verifyCodexReadiness } from "./codex/readiness.js";

/** Prompt content is intentionally never returned, persisted, or logged. */
export const RUNTIME_READINESS_PROMPT =
  "Reply with exactly OK. Do not inspect files, use tools, browse, or perform any other action.";

export type RuntimeReadinessExecutionResult =
  | { ok: true }
  | {
      ok: false;
      error: RuntimeReadinessError;
    };

export type RuntimeReadinessInput = {
  config?: RuntimeReadinessConfig;
  signal: AbortSignal;
};

/** Non-secret identity of the exact executable authority a prepared run owns. */
export type RuntimeReadinessAuthorityIdentity = {
  source: string;
  executablePath: string | null;
};

export type PreparedRuntimeReadiness = {
  authority: RuntimeReadinessAuthorityIdentity;
  verify: (input: RuntimeReadinessInput) => Promise<RuntimeReadinessExecutionResult>;
};

/** Narrow provider seam: one controlled, single-turn host-local verification. */
export type RuntimeReadiness = {
  verify: (input: RuntimeReadinessInput) => Promise<RuntimeReadinessExecutionResult>;
  /**
   * Resolve the actual runtime once, then bind verification to that resolution.
   * Coordinators call this even for cache candidates so executable replacement
   * invalidates a previously Ready result without relying on capability polls.
   */
  prepare?: () => PreparedRuntimeReadiness | Promise<PreparedRuntimeReadiness>;
};

export type RuntimeReadinessTable = Readonly<Partial<Record<RuntimeProvider, RuntimeReadiness>>>;

export type BuiltinRuntimeReadinessDeps = {
  claudeExecutableAuthority?: ClaudeExecutableAuthority;
};

export function asRuntimeReadinessRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type IsolatedWorkspaceDeps = {
  makeTemp?: () => Promise<string>;
  list?: (path: string) => Promise<string[]>;
  setMode?: (path: string, mode: number) => Promise<void>;
  remove?: (path: string) => Promise<void>;
};

/**
 * Run a provider in an empty, read-only temporary cwd and remove it afterwards.
 * A provider-created entry is a policy violation even if the model turn itself
 * otherwise completed successfully.
 */
export async function withIsolatedReadinessWorkspace(
  run: (cwd: string) => Promise<RuntimeReadinessExecutionResult>,
  deps: IsolatedWorkspaceDeps = {},
): Promise<RuntimeReadinessExecutionResult> {
  const makeTemp = deps.makeTemp ?? (() => mkdtemp(join(tmpdir(), "first-tree-readiness-")));
  const list = deps.list ?? ((path) => readdir(path));
  const setMode = deps.setMode ?? ((path, mode) => chmod(path, mode));
  const remove = deps.remove ?? ((path) => rm(path, { force: true, recursive: true }));
  const cwd = await makeTemp();
  try {
    // The provider receives a readable cwd but cannot create or change files
    // there. Its own official credential/session store remains provider-owned.
    await setMode(cwd, 0o500);
    const result = await run(cwd);
    const entries = await list(cwd);
    if (entries.length > 0) {
      return {
        ok: false,
        error: { code: "unsafe_activity", message: "Provider mutated the isolated readiness workspace." },
      };
    }
    return result;
  } finally {
    // Restore owner write permission only so the exact generated temp target can
    // be removed. Never operate on a caller-supplied or unresolved path.
    await setMode(cwd, 0o700).catch(() => undefined);
    // A verdict is not safe to publish while its provider workspace may still
    // exist. Let removal failure reject the run so the coordinator cannot
    // misreport a completed timeout or success before cleanup is proven.
    await remove(cwd);
  }
}

/** Build readiness drivers against the same daemon-local executable authority as sessions. */
export function createBuiltinRuntimeReadiness(deps: BuiltinRuntimeReadinessDeps = {}): RuntimeReadinessTable {
  const authority = deps.claudeExecutableAuthority ?? createClaudeExecutableAuthority();
  return Object.freeze({
    "claude-code": {
      verify: (input) => verifyClaudeCodeReadiness(input, { resolveExecutable: authority.resolve }),
      prepare: () => {
        const resolution = authority.resolve();
        return {
          authority: {
            source: resolution.source,
            executablePath: resolution.path ?? null,
          },
          verify: (input) => verifyClaudeCodeReadiness(input, { resolveExecutable: () => resolution }),
        };
      },
    },
    codex: {
      verify: verifyCodexReadiness,
      prepare: async () => {
        const resolution = await resolveCodexRuntimeBinary();
        return {
          authority: {
            source: resolution.ok ? resolution.runtimeSource : "unavailable",
            executablePath: resolution.ok ? resolution.binary : null,
          },
          verify: (input) => verifyCodexReadiness(input, { resolveBinary: async () => resolution }),
        };
      },
    },
  });
}

export const BUILTIN_RUNTIME_READINESS: RuntimeReadinessTable = createBuiltinRuntimeReadiness();
