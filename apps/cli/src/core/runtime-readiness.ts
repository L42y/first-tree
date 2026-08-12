import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_RUNTIME_READINESS,
  RUNTIME_READINESS_PROMPT,
  type RuntimeReadinessExecutionResult,
  type RuntimeReadinessTable,
  redactErrorPreview,
} from "@first-tree/client";
import type {
  CapabilityEntry,
  RuntimeProvider,
  RuntimeReadinessCheckCommand,
  RuntimeReadinessConfig,
  RuntimeReadinessError,
  RuntimeReadinessResult,
} from "@first-tree/shared";

export const RUNTIME_READINESS_TIMEOUT_MS = 45_000;
export const RUNTIME_READINESS_TTL_MS = 15 * 60_000;
export const RUNTIME_READINESS_ERROR_MAX_LEN = 500;

type RuntimeReadinessCoordinatorDeps = {
  currentEntry: (provider: string) => CapabilityEntry | undefined;
  setProviderEntry: (provider: string, entry: CapabilityEntry) => Promise<void>;
  log: (symbol: string, message: string) => void;
  drivers?: RuntimeReadinessTable;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
};

type InFlightCheck = {
  identity: string;
  promise: Promise<RuntimeReadinessResult>;
  invalidated: boolean;
};

function hashValue(value: string | undefined): string | null {
  return value === undefined ? null : createHash("sha256").update(value).digest("hex");
}

function runtimePathFacts(path: string | null | undefined): Record<string, number | string> | null {
  if (!path) return null;
  try {
    const stat = statSync(path);
    return {
      path,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return { path };
  }
}

function providerLocalIdentityFacts(provider: RuntimeProvider): object {
  const home = homedir();
  if (provider === "codex") {
    const configDir = process.env.CODEX_HOME ?? join(home, ".codex");
    return {
      configDir: runtimePathFacts(configDir),
      auth: runtimePathFacts(join(configDir, "auth.json")),
      config: runtimePathFacts(join(configDir, "config.toml")),
      baseUrl: hashValue(process.env.OPENAI_BASE_URL),
    };
  }
  if (provider === "claude-code") {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
    return {
      configDir: runtimePathFacts(configDir),
      credentials: runtimePathFacts(join(configDir, ".credentials.json")),
      settings: runtimePathFacts(join(configDir, "settings.json")),
      legacyConfig: runtimePathFacts(join(home, ".claude.json")),
      baseUrl: hashValue(process.env.ANTHROPIC_BASE_URL),
    };
  }
  return {};
}

/** Hash only non-secret runtime/config identity facts. */
export function runtimeReadinessIdentity(
  provider: RuntimeProvider,
  entry: CapabilityEntry | undefined,
  config: RuntimeReadinessConfig | undefined,
): string {
  const payload = {
    provider,
    runtimeSource: entry?.runtimeSource ?? null,
    runtimePath: runtimePathFacts(entry?.runtimePath),
    sdkVersion: entry?.sdkVersion ?? null,
    localProviderIdentity: providerLocalIdentityFacts(provider),
    config: {
      model: config?.model ?? null,
      reasoningEffort: config?.reasoningEffort ?? null,
      serviceTier: config?.serviceTier ?? null,
      configIdentity: config?.configIdentity ?? null,
    },
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function safeError(error: RuntimeReadinessError): RuntimeReadinessError {
  if (!error.message) return error;
  const withoutPrompt = error.message.replaceAll(RUNTIME_READINESS_PROMPT, "[readiness prompt]");
  const message = redactErrorPreview(withoutPrompt, RUNTIME_READINESS_ERROR_MAX_LEN - 1);
  return { code: error.code, ...(message ? { message } : {}) };
}

function resultState(execution: RuntimeReadinessExecutionResult): "ready" | "needs_login" | "failed" {
  if (execution.ok) return "ready";
  return execution.error.code === "needs_login" ? "needs_login" : "failed";
}

function installedEntry(entry: CapabilityEntry | undefined): entry is CapabilityEntry {
  return entry?.state === "ok" && entry.available;
}

export class RuntimeReadinessCoordinator {
  private readonly deps: RuntimeReadinessCoordinatorDeps;
  private readonly drivers: RuntimeReadinessTable;
  private readonly inFlight = new Map<RuntimeProvider, InFlightCheck>();
  private readonly lastRequests = new Map<RuntimeProvider, RuntimeReadinessCheckCommand>();
  private readonly latestIdentities = new Map<RuntimeProvider, string>();
  private readonly latestGenerations = new Map<RuntimeProvider, number>();

  constructor(deps: RuntimeReadinessCoordinatorDeps) {
    this.deps = deps;
    this.drivers = deps.drivers ?? BUILTIN_RUNTIME_READINESS;
  }

  async check(command: RuntimeReadinessCheckCommand): Promise<RuntimeReadinessResult> {
    this.lastRequests.set(command.provider, command);
    const entry = this.deps.currentEntry(command.provider);
    const identity = runtimeReadinessIdentity(command.provider, entry, command.config);
    const active = this.inFlight.get(command.provider);
    if (active?.invalidated) {
      this.deps.log(
        "•",
        `runtime-readiness: rejected join with auth-invalidated ${command.provider} check (ref ${command.ref})`,
      );
      return (
        entry?.readiness ?? {
          state: "needs_login",
          identity,
          error: { code: "needs_login" },
        }
      );
    }
    const generation = (this.latestGenerations.get(command.provider) ?? 0) + 1;
    this.latestGenerations.set(command.provider, generation);
    this.latestIdentities.set(command.provider, identity);
    return this.checkGeneration(command, identity, generation);
  }

  private async checkGeneration(
    command: RuntimeReadinessCheckCommand,
    identity: string,
    generation: number,
  ): Promise<RuntimeReadinessResult> {
    const active = this.inFlight.get(command.provider);
    if (active) {
      if (active.identity === identity && !active.invalidated) {
        this.deps.log("•", `runtime-readiness: joined in-flight ${command.provider} check (ref ${command.ref})`);
        return active.promise;
      }
      await active.promise;
      if (this.latestGenerations.get(command.provider) !== generation) {
        return this.supersededResult(command.provider);
      }
      return this.checkGeneration(command, identity, generation);
    }

    const entry = this.deps.currentEntry(command.provider);
    const cached = entry?.readiness;
    const now = (this.deps.now ?? Date.now)();
    if (
      !command.force &&
      !entry?.pendingAuth &&
      !entry?.lastAuthError &&
      cached?.state === "ready" &&
      cached.identity === identity &&
      typeof cached.expiresAt === "string" &&
      Date.parse(cached.expiresAt) > now
    ) {
      this.deps.log("•", `runtime-readiness: reused fresh ${command.provider} result (ref ${command.ref})`);
      return cached;
    }

    const promise = this.execute(command, identity);
    const record = { identity, promise, invalidated: false };
    this.inFlight.set(command.provider, record);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(command.provider) === record) this.inFlight.delete(command.provider);
    }
  }

  /** Successful official login must converge automatically without another click. */
  async retryAfterLogin(provider: RuntimeProvider): Promise<RuntimeReadinessResult> {
    const previous = this.lastRequests.get(provider);
    return this.check({
      type: "runtime-readiness:check",
      provider,
      ...(previous?.config ? { config: previous.config } : {}),
      force: true,
      ref: `login-retry-${Date.now()}`,
    });
  }

  /** Keep a failed official login from leaving a stale cached Ready verdict. */
  async markNeedsLogin(provider: RuntimeProvider): Promise<void> {
    const entry = this.deps.currentEntry(provider);
    if (!entry || (!entry.readiness && !this.lastRequests.has(provider))) return;
    // Fence an older in-flight success before publishing the auth verdict.
    // The next explicit/login-retry check replaces this private sentinel with
    // its real runtime identity; it is never persisted or sent to the Server.
    this.latestIdentities.set(provider, `auth-invalidated:${(this.deps.now ?? Date.now)()}`);
    const active = this.inFlight.get(provider);
    if (active) active.invalidated = true;
    const previous = this.lastRequests.get(provider);
    const now = (this.deps.now ?? Date.now)();
    const readiness: RuntimeReadinessResult = {
      state: "needs_login",
      identity: runtimeReadinessIdentity(provider, entry, previous?.config),
      checkedAt: new Date(now).toISOString(),
      error: { code: "needs_login" },
    };
    await this.deps.setProviderEntry(provider, { ...entry, readiness });
  }

  /** Login recovery remains attached even if a capability re-probe replaced the prior verdict. */
  hasCheckIntent(provider: RuntimeProvider): boolean {
    return this.lastRequests.has(provider) || Boolean(this.deps.currentEntry(provider)?.readiness);
  }

  private async execute(command: RuntimeReadinessCheckCommand, identity: string): Promise<RuntimeReadinessResult> {
    const startedAt = (this.deps.now ?? Date.now)();
    const entry = this.deps.currentEntry(command.provider);
    if (!installedEntry(entry)) {
      return this.publishIfCurrent(command, identity, {
        state: "failed",
        identity,
        checkedAt: new Date(startedAt).toISOString(),
        durationMs: 0,
        error: { code: "provider_unavailable", message: "The provider runtime is not available on this computer." },
      });
    }
    if (entry.pendingAuth || entry.lastAuthError) {
      return this.publishIfCurrent(command, identity, {
        state: "needs_login",
        identity,
        checkedAt: new Date(startedAt).toISOString(),
        durationMs: 0,
        error: { code: "needs_login" },
      });
    }

    const { lastAuthError: _lastAuthError, pendingAuth: _pendingAuth, ...baseEntry } = entry;
    const checking: RuntimeReadinessResult = {
      state: "checking",
      identity,
      checkedAt: new Date(startedAt).toISOString(),
    };
    await this.deps.setProviderEntry(command.provider, { ...baseEntry, readiness: checking });
    this.deps.log("•", `runtime-readiness: checking ${command.provider} (ref ${command.ref})`);

    const driver = this.drivers[command.provider];
    const execution = driver
      ? await this.runBounded((signal) => driver.verify({ config: command.config, signal }))
      : ({
          ok: false,
          error: {
            code: "unsupported_provider",
            message: "Readiness verification is not supported for this provider.",
          },
        } satisfies RuntimeReadinessExecutionResult);
    const finishedAt = (this.deps.now ?? Date.now)();
    const readiness: RuntimeReadinessResult = {
      state: resultState(execution),
      identity,
      checkedAt: new Date(finishedAt).toISOString(),
      durationMs: Math.max(0, finishedAt - startedAt),
      ...(execution.ok
        ? { expiresAt: new Date(finishedAt + (this.deps.ttlMs ?? RUNTIME_READINESS_TTL_MS)).toISOString() }
        : {}),
      ...(!execution.ok ? { error: safeError(execution.error) } : {}),
    };
    const published = await this.publishIfCurrent(command, identity, readiness);
    this.deps.log(
      published.state === "ready" ? "✓" : "⚠️",
      `runtime-readiness: ${command.provider} ${published.state} (ref ${command.ref})`,
    );
    return published;
  }

  private async runBounded(
    run: (signal: AbortSignal) => Promise<RuntimeReadinessExecutionResult>,
  ): Promise<RuntimeReadinessExecutionResult> {
    const controller = new AbortController();
    const timeoutMs = this.deps.timeoutMs ?? RUNTIME_READINESS_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("runtime readiness timed out"));
        resolve("timeout");
      }, timeoutMs);
      timer.unref?.();
    });
    const rawRun = Promise.resolve().then(() => run(controller.signal));
    try {
      const first = await Promise.race([
        rawRun.then(
          (result) => ({ kind: "result" as const, result }),
          () => ({ kind: "error" as const }),
        ),
        timeout.then(() => ({ kind: "timeout" as const })),
      ]);
      if (first.kind === "result") return first.result;
      if (first.kind === "error") {
        return {
          ok: false,
          error: { code: "provider_error", message: "The readiness provider failed unexpectedly." },
        };
      }

      // Provider adapters own bounded teardown (Claude SDK abort cleanup;
      // Codex SIGTERM→SIGKILL escalation). Do not publish `timeout`, release
      // the in-flight slot, or allow another run until the adapter has settled
      // and its isolated workspace removal has completed successfully.
      try {
        await rawRun;
      } catch {
        return {
          ok: false,
          error: { code: "provider_error", message: "Readiness cleanup failed after cancellation." },
        };
      }
      return { ok: false, error: { code: "timeout", message: `Readiness timed out after ${timeoutMs}ms.` } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async publishIfCurrent(
    command: RuntimeReadinessCheckCommand,
    identity: string,
    readiness: RuntimeReadinessResult,
  ): Promise<RuntimeReadinessResult> {
    const current = this.deps.currentEntry(command.provider);
    const currentIdentity = runtimeReadinessIdentity(command.provider, current, command.config);
    const active = this.inFlight.get(command.provider);
    if (
      currentIdentity !== identity ||
      this.latestIdentities.get(command.provider) !== identity ||
      (active?.identity === identity && active.invalidated)
    ) {
      this.deps.log("•", `runtime-readiness: discarded stale ${command.provider} result (ref ${command.ref})`);
      return { state: "available", identity: currentIdentity };
    }
    if (current?.readiness && current.readiness.identity !== identity && current.readiness.state === "checking") {
      this.deps.log("•", `runtime-readiness: newer ${command.provider} check superseded ref ${command.ref}`);
      return current.readiness;
    }
    const entry = current ?? {
      state: "error" as const,
      available: false,
      detectedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
    };
    await this.deps.setProviderEntry(command.provider, { ...entry, readiness });
    return readiness;
  }

  private supersededResult(provider: RuntimeProvider): RuntimeReadinessResult {
    const current = this.deps.currentEntry(provider)?.readiness;
    if (current) return current;
    return {
      state: "available",
      identity: this.latestIdentities.get(provider) ?? runtimeReadinessIdentity(provider, undefined, undefined),
    };
  }
}
