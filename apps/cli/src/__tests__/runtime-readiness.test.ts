import { RUNTIME_READINESS_PROMPT, type RuntimeReadinessExecutionResult } from "@first-tree/client";
import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeReadinessCoordinator, runtimeReadinessIdentity } from "../core/runtime-readiness.js";

const NOW = Date.parse("2026-08-12T08:00:00.000Z");

function installed(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    state: "ok",
    available: true,
    runtimeSource: "path",
    runtimePath: "/not/a/real/codex",
    sdkVersion: "0.144.1",
    detectedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function harness(options: {
  entry?: CapabilityEntry;
  verify?: (signal: AbortSignal) => Promise<RuntimeReadinessExecutionResult>;
  authority?: () => { source: string; executablePath: string | null };
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
}) {
  let entry = options.entry ?? installed();
  const writes: CapabilityEntry[] = [];
  const verify = vi.fn(options.verify ?? (async () => ({ ok: true as const })));
  const coordinator = new RuntimeReadinessCoordinator({
    currentEntry: () => entry,
    setProviderEntry: async (_provider, next) => {
      entry = next;
      writes.push(next);
    },
    log: vi.fn(),
    now: () => NOW,
    timeoutMs: options.timeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
    ttlMs: 60_000,
    drivers: {
      codex: {
        verify: ({ signal }) => verify(signal),
        ...(options.authority
          ? {
              prepare: () => ({
                authority: options.authority?.() ?? { source: "provider-default", executablePath: null },
                verify: ({ signal }: { signal: AbortSignal }) => verify(signal),
              }),
            }
          : {}),
      },
    },
  });
  return {
    coordinator,
    verify,
    writes,
    current: () => entry,
    replace: (next: CapabilityEntry) => {
      entry = next;
    },
  };
}

function command(provider: RuntimeProvider = "codex") {
  return { type: "runtime-readiness:check" as const, provider, ref: `ref-${provider}` };
}

describe("RuntimeReadinessCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("changes cache identity when host-local auth metadata changes without reading credentials", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "first-tree-readiness-identity-"));
    vi.stubEnv("CODEX_HOME", codexHome);
    try {
      writeFileSync(join(codexHome, "auth.json"), "first");
      const before = runtimeReadinessIdentity("codex", installed(), undefined);
      writeFileSync(join(codexHome, "auth.json"), "second-longer");
      const after = runtimeReadinessIdentity("codex", installed(), undefined);
      expect(after).not.toBe(before);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent checks and reuses a fresh result for the same runtime identity", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      verify: async () =>
        new Promise<{ ok: true }>((resolve) => {
          release = () => resolve({ ok: true });
        }),
    });

    const first = h.coordinator.check(command());
    const second = h.coordinator.check({ ...command(), ref: "joined" });
    await vi.waitFor(() => expect(h.verify).toHaveBeenCalledTimes(1));
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: "ready" }),
      expect.objectContaining({ state: "ready" }),
    ]);
    await expect(h.coordinator.check({ ...command(), ref: "cached" })).resolves.toMatchObject({ state: "ready" });
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("invalidates cached Ready when the prepared execution authority changes without a capability poll", async () => {
    let executablePath = "/runtime/claude-a";
    const h = harness({
      authority: () => ({ source: "path", executablePath }),
    });

    const first = await h.coordinator.check(command());
    expect(first).toMatchObject({ state: "ready" });
    expect(h.verify).toHaveBeenCalledTimes(1);

    await expect(h.coordinator.check({ ...command(), ref: "same-authority" })).resolves.toMatchObject({
      state: "ready",
    });
    expect(h.verify).toHaveBeenCalledTimes(1);

    executablePath = "/runtime/claude-b";
    const replacement = await h.coordinator.check({ ...command(), ref: "replacement-authority" });
    expect(replacement).toMatchObject({ state: "ready" });
    expect(replacement.identity).not.toBe(first.identity);
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it("times out one bounded provider turn", async () => {
    vi.useFakeTimers();
    const h = harness({
      verify: async (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ ok: false, error: { code: "cancelled" } }), {
            once: true,
          });
        }),
      timeoutMs: 25,
    });
    const result = h.coordinator.check(command());
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toMatchObject({ state: "failed", error: { code: "timeout" } });
  });

  it("publishes timeout only after cancellation cleanup and then permits a new run", async () => {
    vi.useFakeTimers();
    let finishCleanup: (() => void) | undefined;
    let callCount = 0;
    const h = harness({
      verify: async (signal) => {
        callCount += 1;
        if (callCount > 1) return { ok: true };
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              finishCleanup = () => resolve({ ok: false, error: { code: "cancelled" } });
            },
            { once: true },
          );
        });
      },
      timeoutMs: 25,
    });
    const first = h.coordinator.check(command());
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(finishCleanup).toBeDefined());
    let published = false;
    void first.then(() => {
      published = true;
    });
    await Promise.resolve();
    expect(published).toBe(false);

    finishCleanup?.();
    await expect(first).resolves.toMatchObject({ state: "failed", error: { code: "timeout" } });
    await expect(h.coordinator.check({ ...command(), force: true, ref: "after-cleanup" })).resolves.toMatchObject({
      state: "ready",
    });
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it("bounds an uncooperative provider seam and quarantines overlapping reruns", async () => {
    vi.useFakeTimers();
    const h = harness({
      verify: async () => new Promise(() => undefined),
      timeoutMs: 25,
      cleanupTimeoutMs: 25,
    });
    const first = h.coordinator.check(command());
    await vi.advanceTimersByTimeAsync(50);
    await expect(first).resolves.toMatchObject({ state: "failed", error: { code: "provider_busy" } });

    await expect(h.coordinator.check({ ...command(), force: true, ref: "quarantined" })).resolves.toMatchObject({
      state: "failed",
      error: { code: "provider_busy" },
    });
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("redacts provider errors before publishing them", async () => {
    const h = harness({
      verify: async () => ({
        ok: false,
        error: {
          code: "provider_error",
          message: `Authorization: Bearer sk-secret-value; prompt=${RUNTIME_READINESS_PROMPT}`,
        },
      }),
    });
    const result = await h.coordinator.check(command());
    expect(result.state).toBe("failed");
    expect(result.error?.message).not.toContain("sk-secret-value");
    expect(result.error?.message).not.toContain(RUNTIME_READINESS_PROMPT);
  });

  it("discards a result when the actual runtime identity changes in flight", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      verify: async () =>
        new Promise<{ ok: true }>((resolve) => {
          release = () => resolve({ ok: true });
        }),
    });
    const result = h.coordinator.check(command());
    await vi.waitFor(() => expect(h.verify).toHaveBeenCalledTimes(1));
    h.replace(installed({ runtimePath: "/not/a/real/new-codex" }));
    release?.();

    await expect(result).resolves.toMatchObject({ state: "available" });
    expect(h.current().readiness).toBeUndefined();
  });

  it("discards a result when the prepared execution authority changes in flight", async () => {
    let executablePath = "/runtime/claude-a";
    let release: (() => void) | undefined;
    const h = harness({
      authority: () => ({ source: "path", executablePath }),
      verify: async () =>
        new Promise<{ ok: true }>((resolve) => {
          release = () => resolve({ ok: true });
        }),
    });

    const result = h.coordinator.check(command());
    await vi.waitFor(() => expect(h.verify).toHaveBeenCalledTimes(1));
    executablePath = "/runtime/claude-b";
    release?.();

    await expect(result).resolves.toMatchObject({ state: "available" });
    expect(h.current().readiness).toBeUndefined();
  });

  it("lets the newest provider configuration supersede an older in-flight result", async () => {
    let releaseFirst: (() => void) | undefined;
    let callCount = 0;
    const h = harness({
      verify: async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise<{ ok: true }>((resolve) => {
            releaseFirst = () => resolve({ ok: true });
          });
        }
        return { ok: true };
      },
    });
    const first = h.coordinator.check({ ...command(), config: { model: "old-model" } });
    await vi.waitFor(() => expect(h.verify).toHaveBeenCalledTimes(1));
    const newest = h.coordinator.check({ ...command(), ref: "new-config", config: { model: "new-model" } });
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({ state: "available" });
    await expect(newest).resolves.toMatchObject({ state: "ready" });
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(h.current().readiness).toMatchObject({
      state: "ready",
      identity: runtimeReadinessIdentity(
        "codex",
        h.current(),
        { model: "new-model" },
        {
          source: "provider-default",
          executablePath: null,
        },
      ),
    });
  });

  it("fails closed at an unsupported provider boundary without calling another driver", async () => {
    const h = harness({});
    await expect(h.coordinator.check(command("cursor"))).resolves.toMatchObject({
      state: "failed",
      error: { code: "unsupported_provider" },
    });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("does not spend a provider turn while official login is pending", async () => {
    const h = harness({
      entry: installed({
        pendingAuth: {
          method: "browser",
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
      }),
    });
    await expect(h.coordinator.check(command())).resolves.toMatchObject({
      state: "needs_login",
      error: { code: "needs_login" },
    });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("invalidates Ready on auth failure and retries automatically after successful login", async () => {
    const h = harness({
      entry: installed({
        readiness: {
          state: "ready",
          identity: runtimeReadinessIdentity("codex", installed(), undefined),
          checkedAt: new Date(NOW).toISOString(),
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
      }),
    });
    await h.coordinator.check({ ...command(), force: true });
    await h.coordinator.markNeedsLogin("codex");
    expect(h.current().readiness).toMatchObject({ state: "needs_login", error: { code: "needs_login" } });

    await expect(h.coordinator.retryAfterLogin("codex")).resolves.toMatchObject({ state: "ready" });
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it("prevents an in-flight success from overwriting a newer auth-failure verdict", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      verify: async () =>
        new Promise<{ ok: true }>((resolve) => {
          release = () => resolve({ ok: true });
        }),
    });
    const check = h.coordinator.check(command());
    await vi.waitFor(() => expect(h.verify).toHaveBeenCalledTimes(1));
    await h.coordinator.markNeedsLogin("codex");
    await expect(h.coordinator.check({ ...command(), force: true, ref: "post-auth-trigger" })).resolves.toMatchObject({
      state: "needs_login",
      error: { code: "needs_login" },
    });
    expect(h.verify).toHaveBeenCalledTimes(1);
    release?.();

    await expect(check).resolves.toMatchObject({ state: "available" });
    expect(h.current().readiness).toMatchObject({ state: "needs_login", error: { code: "needs_login" } });
  });

  it("queues the automatic login retry behind an invalidated in-flight check", async () => {
    let release: (() => void) | undefined;
    let callCount = 0;
    const h = harness({
      verify: async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise((resolve) => {
            release = () => resolve({ ok: true });
          });
        }
        return { ok: true };
      },
    });
    const stale = h.coordinator.check(command());
    await vi.waitFor(() => expect(h.verify).toHaveBeenCalledTimes(1));
    await h.coordinator.markNeedsLogin("codex");

    const retry = h.coordinator.retryAfterLogin("codex");
    await Promise.resolve();
    expect(h.verify).toHaveBeenCalledTimes(1);
    release?.();

    await expect(stale).resolves.toMatchObject({ state: "available" });
    await expect(retry).resolves.toMatchObject({ state: "ready" });
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it("does not create a readiness verdict for auth failures before readiness was requested", async () => {
    const h = harness({});
    await h.coordinator.markNeedsLogin("codex");
    expect(h.current().readiness).toBeUndefined();
  });

  it("retains readiness intent across a failed login re-probe and retries after later success", async () => {
    const h = harness({
      verify: async () => ({ ok: false, error: { code: "needs_login", message: "login required" } }),
    });
    await h.coordinator.check(command());
    expect(h.coordinator.hasCheckIntent("codex")).toBe(true);

    // Runtime-auth reflect() replaces the capability row with a fresh
    // install-only probe after a failed login.
    h.replace(installed());
    await h.coordinator.markNeedsLogin("codex");
    expect(h.current().readiness).toMatchObject({ state: "needs_login" });

    h.verify.mockResolvedValue({ ok: true });
    await expect(h.coordinator.retryAfterLogin("codex")).resolves.toMatchObject({ state: "ready" });
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
