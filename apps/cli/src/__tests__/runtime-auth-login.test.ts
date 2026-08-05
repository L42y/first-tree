import {
  BROWSER_LOGIN_TIMEOUT_MS,
  type LoginOutcome,
  type RuntimeAuthDriver,
  type RuntimeAuthDriverTable,
  type RuntimeAuthProbeResult,
} from "@first-tree/client";
import type { CapabilityEntry, RuntimeAuthProvider } from "@first-tree/shared";
import { runtimeAuthProviderSchema } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import {
  RUNTIME_AUTH_ERROR_MAX_LEN,
  type RuntimeAuthLoginDeps,
  runRuntimeAuthLogin,
} from "../core/runtime-auth-login.js";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");

// Detection is install-only: a re-probed installed provider is always `ok` (no
// auth state). Tests override `state`/`available` for the binary-vanished case.
const okEntry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "ok",
  available: true,
  sdkVersion: "0.130.0",
  detectedAt: "2026-06-22T12:00:01.000Z",
  ...over,
});

type Recorded = { provider: string; entry: CapabilityEntry };

type FakeDriverOptions = {
  provider: RuntimeAuthProvider;
  logLabel?: string;
  loginLabel?: string;
  artifactLabel?: string;
  resolveError?: string;
  throwResolve?: unknown;
  outcome?: LoginOutcome;
  fireAuthUrl?: string;
  throwLogin?: unknown;
  probeThrows?: unknown;
  probeResult?: CapabilityEntry;
  /** Extra rows a shared-credential provider republishes alongside its own. */
  extraRows?: readonly RuntimeAuthProbeResult[];
};

function fakeDriver(opts: FakeDriverOptions) {
  const loginCalls: number[] = [];
  const driver: RuntimeAuthDriver = {
    logLabel: opts.logLabel ?? opts.provider,
    loginLabel: opts.loginLabel ?? `${opts.provider} login`,
    artifactLabel: opts.artifactLabel ?? "binary",
    async resolveLogin() {
      if (opts.throwResolve !== undefined) throw opts.throwResolve;
      if (opts.resolveError) return { ok: false, error: opts.resolveError };
      return {
        ok: true,
        login: async ({ onAuthUrl }) => {
          loginCalls.push(1);
          if (opts.fireAuthUrl) onAuthUrl(opts.fireAuthUrl);
          if (opts.throwLogin !== undefined) throw opts.throwLogin;
          await new Promise((r) => setTimeout(r, 0));
          return opts.outcome ?? { ok: true };
        },
      };
    },
    async reprobe() {
      if (opts.probeThrows !== undefined) throw opts.probeThrows;
      return [{ provider: opts.provider, entry: opts.probeResult ?? okEntry() }, ...(opts.extraRows ?? [])];
    },
  };
  return { driver, loginCalls };
}

function harness(
  driver: RuntimeAuthDriver,
  provider: RuntimeAuthProvider,
  current?: CapabilityEntry,
  /** Per-write latency, to expose ordering that a fast write would hide. */
  writeDelayMs?: (entry: CapabilityEntry) => number,
) {
  const calls: Recorded[] = [];
  const logs: string[] = [];
  const drivers = { [provider]: driver } as unknown as RuntimeAuthDriverTable;
  const deps: RuntimeAuthLoginDeps = {
    currentEntry: () => current,
    setProviderEntry: async (p, entry) => {
      const delay = writeDelayMs?.(entry) ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      calls.push({ provider: p, entry });
    },
    log: (_symbol, msg) => {
      logs.push(msg);
    },
    now: () => NOW,
    drivers,
  };
  return { calls, logs, deps };
}

describe("runRuntimeAuthLogin — generic dispatch", () => {
  it("dispatches by typed key into the supplied registry", async () => {
    const seen: RuntimeAuthProvider[] = [];
    const drivers = {} as Record<RuntimeAuthProvider, RuntimeAuthDriver>;
    for (const provider of runtimeAuthProviderSchema.options) {
      drivers[provider] = {
        logLabel: provider,
        loginLabel: `${provider} login`,
        artifactLabel: "binary",
        resolveLogin: async () => {
          seen.push(provider);
          return { ok: false, error: `${provider} not installed` };
        },
        reprobe: async () => [{ provider, entry: okEntry() }],
      };
    }

    const calls: Recorded[] = [];
    for (const provider of runtimeAuthProviderSchema.options) {
      await runRuntimeAuthLogin(
        { provider, ref: `dispatch-${provider}` },
        {
          currentEntry: () => undefined,
          setProviderEntry: async (p, entry) => {
            calls.push({ provider: p, entry });
          },
          log: vi.fn(),
          now: () => NOW,
          drivers,
        },
      );
    }

    expect(seen).toEqual([...runtimeAuthProviderSchema.options]);
    expect(calls.map((c) => c.provider)).toEqual([...runtimeAuthProviderSchema.options]);
  });

  it("logs and stops when the registry has no driver for the provider", async () => {
    const logs: string[] = [];
    const calls: Recorded[] = [];
    await runRuntimeAuthLogin(
      { provider: "codex", ref: "r4" },
      {
        currentEntry: () => undefined,
        setProviderEntry: async (provider, entry) => {
          calls.push({ provider, entry });
        },
        log: (_s, msg) => {
          logs.push(msg);
        },
        drivers: {} as RuntimeAuthDriverTable,
      },
    );

    expect(calls).toHaveLength(0);
    expect(logs.some((l) => l.includes("not supported yet"))).toBe(true);
  });
});

describe("runRuntimeAuthLogin — browser OAuth lifecycle", () => {
  it("publishes a browser pending then the re-probed ok entry", async () => {
    const { driver } = fakeDriver({ provider: "codex", outcome: { ok: true } });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "r1" }, h.deps);

    expect(h.calls).toHaveLength(2);
    // First: the install entry (no prior entry → minimal `ok`) with a browser
    // pending marker layered on, so the web shows "finish in browser".
    expect(h.calls[0]?.entry.state).toBe("ok");
    expect(h.calls[0]?.entry.pendingAuth).toEqual({
      method: "browser",
      expiresAt: new Date(NOW + BROWSER_LOGIN_TIMEOUT_MS).toISOString(),
    });
    // Then: the cleared (marker-free) install entry from the re-probe.
    expect(h.calls[1]?.entry.state).toBe("ok");
    expect(h.calls[1]?.entry.pendingAuth).toBeUndefined();
  });

  it("surfaces the browser auth URL into pendingAuth (no-auto-open recovery)", async () => {
    const { driver } = fakeDriver({ provider: "codex", fireAuthUrl: "https://auth.openai.com/x" });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "u1" }, h.deps);

    const withUrl = h.calls.find((c) => c.entry.pendingAuth?.authUrl);
    expect(withUrl?.entry.pendingAuth).toMatchObject({ method: "browser", authUrl: "https://auth.openai.com/x" });
  });

  it("keeps the auth URL ahead of the terminal entry even when the write is slow", async () => {
    // The URL arrives from the login's output stream, so its write is in flight
    // when the login resolves. A slow write must not land after the terminal
    // re-probe and resurrect a pending marker on a finished login.
    const { driver } = fakeDriver({ provider: "codex", fireAuthUrl: "https://auth.openai.com/slow" });
    const h = harness(driver, "codex", undefined, (entry) => (entry.pendingAuth?.authUrl ? 20 : 0));
    await runRuntimeAuthLogin({ provider: "codex", ref: "order" }, h.deps);

    expect(
      h.calls.map((c) => (c.entry.pendingAuth?.authUrl ? "pending+url" : c.entry.pendingAuth ? "pending" : "terminal")),
    ).toEqual(["pending", "pending+url", "terminal"]);
  });

  it("preserves the prior entry's runtimeSource/version on the pending entry", async () => {
    const { driver } = fakeDriver({ provider: "codex" });
    const h = harness(driver, "codex", okEntry({ runtimeSource: "bundled" }));
    await runRuntimeAuthLogin({ provider: "codex", ref: "r2" }, h.deps);

    expect(h.calls[0]?.entry.runtimeSource).toBe("bundled");
    expect(h.calls[0]?.entry.sdkVersion).toBe("0.130.0");
  });

  it("on an unresolved artifact, reflects the real state and never logs in", async () => {
    const { driver, loginCalls } = fakeDriver({
      provider: "codex",
      resolveError: "codex binary missing",
      probeResult: okEntry({ state: "missing", available: false }),
    });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "r3" }, h.deps);

    expect(loginCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.entry.state).toBe("missing");
    expect(h.logs.some((l) => l.includes("codex binary unavailable"))).toBe(true);
  });

  it("contains a thrown resolver on the same path as a reported one", async () => {
    const { driver, loginCalls } = fakeDriver({
      provider: "codex",
      throwResolve: new Error("PATH lookup exploded"),
      probeResult: okEntry({ state: "missing", available: false }),
    });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "resolve-throw" }, h.deps);

    expect(loginCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.entry.state).toBe("missing");
    expect(h.calls[0]?.entry.lastAuthError).toMatchObject({
      reason: "spawn-error",
      message: "PATH lookup exploded",
    });
    expect(h.logs.some((l) => l.includes("codex binary lookup threw: PATH lookup exploded"))).toBe(true);
  });

  it("uses the driver's artifact wording for a CLI-backed provider", async () => {
    const { driver } = fakeDriver({
      provider: "claude-code",
      logLabel: "claude",
      loginLabel: "claude auth login",
      artifactLabel: "CLI",
      resolveError: "no claude CLI",
      probeThrows: "probe crashed",
    });
    const h = harness(driver, "claude-code");
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c2" }, h.deps);

    expect(h.logs.some((l) => l.includes("claude CLI unavailable: no claude CLI"))).toBe(true);
    expect(h.logs.some((l) => l.includes("claude re-probe after unresolved CLI failed: probe crashed"))).toBe(true);
  });

  it("stamps lastAuthError on the re-probed entry when the login fails", async () => {
    const { driver } = fakeDriver({
      provider: "codex",
      outcome: { ok: false, reason: "exit-nonzero", error: "account not authorized" },
    });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "f1" }, h.deps);

    const last = h.calls.at(-1)?.entry;
    // The re-probed install entry stays `ok` (install-only detection); the
    // failure stamps `lastAuthError` so the web shows "sign-in failed — retry".
    expect(last?.state).toBe("ok");
    expect(last?.pendingAuth).toBeUndefined();
    expect(last?.lastAuthError).toMatchObject({ reason: "exit-nonzero", message: "account not authorized" });
    expect(last?.lastAuthError?.at).toBe(new Date(NOW).toISOString());
  });

  it("leaves no lastAuthError after a successful login", async () => {
    const { driver } = fakeDriver({ provider: "codex", outcome: { ok: true } });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "f2" }, h.deps);
    expect(h.calls.at(-1)?.entry.lastAuthError).toBeUndefined();
  });

  it("stamps lastAuthError even when the re-probe lands `missing`", async () => {
    const { driver } = fakeDriver({
      provider: "codex",
      resolveError: "codex binary missing",
      probeResult: okEntry({ state: "missing", available: false }),
    });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "f3" }, h.deps);

    expect(h.calls.at(-1)?.entry.state).toBe("missing");
    expect(h.calls.at(-1)?.entry.lastAuthError).toMatchObject({ reason: "spawn-error" });
  });

  it("logs thrown login errors and re-probe failures without throwing", async () => {
    const loginThrows = harness(fakeDriver({ provider: "codex", throwLogin: "browser crashed" }).driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "throw-login" }, loginThrows.deps);
    expect(loginThrows.logs.some((l) => l.includes("codex login threw: browser crashed"))).toBe(true);
    expect(loginThrows.calls.at(-1)?.entry.lastAuthError).toMatchObject({
      reason: "spawn-error",
      message: "browser crashed",
    });

    const probeThrows = harness(
      fakeDriver({ provider: "codex", resolveError: "codex binary missing", probeThrows: "probe crashed" }).driver,
      "codex",
    );
    await runRuntimeAuthLogin({ provider: "codex", ref: "throw-probe" }, probeThrows.deps);
    expect(
      probeThrows.logs.some((l) => l.includes("codex re-probe after unresolved binary failed: probe crashed")),
    ).toBe(true);
  });
});

describe("runRuntimeAuthLogin — shared-credential providers", () => {
  it("republishes every row the driver returns, stamping only the login target", async () => {
    const { driver } = fakeDriver({
      provider: "claude-code",
      logLabel: "claude",
      loginLabel: "claude auth login",
      artifactLabel: "CLI",
      outcome: { ok: false, reason: "timeout", error: "claude auth login timed out" },
      probeResult: okEntry({ sdkVersion: "sdk" }),
      extraRows: [{ provider: "claude-code-tui", entry: okEntry({ sdkVersion: "tui" }) }],
    });
    const h = harness(driver, "claude-code");
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c3" }, h.deps);

    expect(h.calls.map((c) => c.provider)).toEqual(["claude-code", "claude-code", "claude-code-tui"]);
    const cc = h.calls.filter((c) => c.provider === "claude-code").at(-1)?.entry;
    expect(cc?.lastAuthError).toMatchObject({ reason: "timeout", message: "claude auth login timed out" });
    // The shared-keychain row reflects the re-probe only; the failure belongs to
    // the row the operator actually tried to log in.
    expect(h.calls.at(-1)?.entry.lastAuthError).toBeUndefined();
  });
});

/**
 * Ordinary diagnostic prose, long enough to blow the budget on its own and
 * deliberately free of every shape the redaction helper matches — no
 * credential-ish key, no `Bearer`, no `sk-` run, no scheme with userinfo. A
 * secret that IS matched collapses into a short placeholder, so a test that
 * only feeds a secret proves redaction and never reaches the cap; pairing the
 * two on separate lines is what exercises both.
 */
const LONG_DIAGNOSTIC_TAIL = "the provider kept printing ordinary diagnostic prose ".repeat(40);

describe("runRuntimeAuthLogin — published failure text is redacted and bounded (#1720)", () => {
  it("redacts credential shapes before they reach the capability snapshot", async () => {
    const { driver } = fakeDriver({
      provider: "codex",
      outcome: {
        ok: false,
        reason: "exit-nonzero",
        error:
          "refresh failed for https://user:hunter2pwd@auth.example/cb (Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwx)",
      },
    });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "redact" }, h.deps);

    const published = h.calls.at(-1)?.entry.lastAuthError?.message ?? "";
    expect(published).not.toContain("hunter2pwd");
    expect(published).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx");
    expect(published).toContain("[REDACTED]");
  });

  it("hard-caps an over-long provider failure at the capability error budget", async () => {
    const { driver } = fakeDriver({
      provider: "codex",
      outcome: { ok: false, reason: "exit-nonzero", error: "boom ".repeat(1_000) },
    });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "cap" }, h.deps);

    const published = h.calls.at(-1)?.entry.lastAuthError?.message ?? "";
    // The budget is the ceiling on the published string, ellipsis included —
    // the redaction helper appends one when it truncates.
    expect(published.length).toBe(RUNTIME_AUTH_ERROR_MAX_LEN);
    expect(published.endsWith("…")).toBe(true);
  });

  it("leaves a message that fits the budget exactly as it is", async () => {
    const { driver } = fakeDriver({
      provider: "codex",
      outcome: { ok: false, reason: "exit-nonzero", error: "account not authorized" },
    });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "short" }, h.deps);

    const published = h.calls.at(-1)?.entry.lastAuthError?.message;
    expect(published).toBe("account not authorized");
  });

  it("sanitizes a probe-reported error on the login target's row", async () => {
    const { driver } = fakeDriver({
      provider: "codex",
      probeResult: okEntry({
        state: "error",
        available: false,
        error: `detect failed for https://svc:hunter2pwd@registry.example/x\n${LONG_DIAGNOSTIC_TAIL}`,
      }),
    });
    const h = harness(driver, "codex");
    await runRuntimeAuthLogin({ provider: "codex", ref: "probe-error" }, h.deps);

    const published = h.calls.at(-1)?.entry.error ?? "";
    expect(published).not.toContain("hunter2pwd");
    expect(published).toContain("[REDACTED]");
    // The tail survives redaction, so the cap is what ends the string.
    expect(published.length).toBe(RUNTIME_AUTH_ERROR_MAX_LEN);
    expect(published.endsWith("…")).toBe(true);
  });

  it("sanitizes a probe-reported error on a shared-credential extra row too", async () => {
    const { driver } = fakeDriver({
      provider: "claude-code",
      logLabel: "claude",
      artifactLabel: "CLI",
      extraRows: [
        {
          provider: "claude-code-tui",
          entry: okEntry({
            state: "error",
            available: false,
            // The Authorization pattern eats to end-of-line, so the tail has to
            // start on the next one to reach the cap.
            error: `tui detect failed\nAuthorization: Bearer sk-ant-abcdefghijklmnopqrstuvwx\n${LONG_DIAGNOSTIC_TAIL}`,
          }),
        },
      ],
    });
    const h = harness(driver, "claude-code");
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "tui-probe-error" }, h.deps);

    const tuiRow = h.calls.filter((c) => c.provider === "claude-code-tui").at(-1)?.entry;
    expect(tuiRow?.error).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx");
    expect(tuiRow?.error).toContain("[REDACTED]");
    expect(tuiRow?.error?.length).toBe(RUNTIME_AUTH_ERROR_MAX_LEN);
    expect(tuiRow?.error?.endsWith("…")).toBe(true);
    // The extra row still carries no failure marker — that belongs to the target.
    expect(tuiRow?.lastAuthError).toBeUndefined();
  });

  it("drops the previous attempt's error and failure marker from the pending entry", async () => {
    const { driver } = fakeDriver({ provider: "codex" });
    const stale = okEntry({
      state: "error",
      available: false,
      error: "old detect failure for https://svc:hunter2pwd@registry.example/x",
      lastAuthError: { reason: "timeout", message: "an earlier sign-in timed out", at: "2026-06-21T00:00:00.000Z" },
    });
    const h = harness(driver, "codex", stale);
    await runRuntimeAuthLogin({ provider: "codex", ref: "stale" }, h.deps);

    const pending = h.calls[0]?.entry;
    expect(pending?.pendingAuth).toBeDefined();
    // Starting a login clears the last verdict; nothing from it may ride along.
    expect(pending?.error).toBeUndefined();
    expect(pending?.lastAuthError).toBeUndefined();
    expect(pending?.state).toBe("ok");
  });

  it("caps a thrown error and an unresolved-artifact error too", async () => {
    const thrown = harness(
      fakeDriver({
        provider: "codex",
        throwLogin: new Error(`spawn failed with token=abcdef1234567890\n${LONG_DIAGNOSTIC_TAIL}`),
      }).driver,
      "codex",
    );
    await runRuntimeAuthLogin({ provider: "codex", ref: "cap-throw" }, thrown.deps);
    const thrownMessage = thrown.calls.at(-1)?.entry.lastAuthError?.message ?? "";
    expect(thrownMessage).not.toContain("abcdef1234567890");
    expect(thrownMessage).toContain("[REDACTED]");
    expect(thrownMessage.length).toBe(RUNTIME_AUTH_ERROR_MAX_LEN);
    expect(thrownMessage.endsWith("…")).toBe(true);

    const unresolved = harness(
      fakeDriver({
        provider: "codex",
        resolveError: `no codex at https://svc:pw_abcdef@registry.example/x\n${LONG_DIAGNOSTIC_TAIL}`,
      }).driver,
      "codex",
    );
    await runRuntimeAuthLogin({ provider: "codex", ref: "cap-resolve" }, unresolved.deps);
    const resolveMessage = unresolved.calls.at(-1)?.entry.lastAuthError?.message ?? "";
    expect(resolveMessage).not.toContain("pw_abcdef");
    expect(resolveMessage.length).toBe(RUNTIME_AUTH_ERROR_MAX_LEN);
    expect(resolveMessage.endsWith("…")).toBe(true);
  });
});
