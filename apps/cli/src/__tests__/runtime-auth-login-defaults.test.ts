import type { CapabilityEntry } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The daemon must reach the Client's frozen `RUNTIME_AUTH_DRIVERS` when no
 * registry is injected. Mocking that export (rather than each provider's
 * resolver / login / probe) is what keeps this file provider-neutral: the
 * dispatcher is only allowed to know a typed key and the driver contract.
 */
describe("runRuntimeAuthLogin default driver registry", () => {
  afterEach(() => {
    vi.doUnmock("@first-tree/client");
    vi.resetModules();
  });

  async function loadWithDefaultDrivers(drivers: Record<string, unknown>) {
    vi.doMock("@first-tree/client", () => ({
      BROWSER_LOGIN_TIMEOUT_MS: 120_000,
      redactErrorPreview: (input: string, maxLen: number) => input.slice(0, maxLen),
      RUNTIME_AUTH_DRIVERS: drivers,
    }));
    return await import("../core/runtime-auth-login.js");
  }

  it("resolves each auth provider through the default table when deps omit one", async () => {
    const resolved: string[] = [];
    const build = (provider: string, logLabel: string, artifactLabel: string) => ({
      logLabel,
      loginLabel: `${logLabel} login`,
      artifactLabel,
      resolveLogin: async () => {
        resolved.push(provider);
        return {
          ok: true as const,
          login: async ({ onAuthUrl }: { onAuthUrl: (url: string) => void }) => {
            onAuthUrl(`https://auth.example/${provider}`);
            return { ok: false as const, reason: "timeout" as const, error: "" };
          },
        };
      },
      reprobe: async () => [
        { provider, entry: { state: "ok", available: true, detectedAt: "2026-06-22T12:00:00.000Z" } },
      ],
    });

    const { runRuntimeAuthLogin } = await loadWithDefaultDrivers({
      "claude-code": build("claude-code", "claude", "CLI"),
      codex: build("codex", "codex", "binary"),
      cursor: build("cursor", "cursor", "binary"),
      grok: build("grok", "grok", "binary"),
    });

    const calls: Array<{ provider: string; entry: CapabilityEntry }> = [];
    for (const provider of ["claude-code", "codex", "cursor", "grok"] as const) {
      await runRuntimeAuthLogin(
        { provider, ref: `default-${provider}` },
        {
          currentEntry: () => undefined,
          setProviderEntry: async (p, entry) => {
            calls.push({ provider: p, entry });
          },
          log: vi.fn(),
        },
      );
    }

    expect(resolved).toEqual(["claude-code", "codex", "cursor", "grok"]);
    // Every provider walks pending → authUrl → re-probe with a terminal marker.
    for (const provider of ["claude-code", "codex", "cursor", "grok"]) {
      const forProvider = calls.filter((c) => c.provider === provider);
      expect(forProvider, provider).toHaveLength(3);
      expect(forProvider[1]?.entry.pendingAuth?.authUrl, provider).toBe(`https://auth.example/${provider}`);
      expect(forProvider.at(-1)?.entry.lastAuthError, provider).toEqual({
        reason: "timeout",
        at: expect.any(String),
      });
    }
  });

  it("logs a thrown login from the default table without throwing", async () => {
    const { runRuntimeAuthLogin } = await loadWithDefaultDrivers({
      codex: {
        logLabel: "codex",
        loginLabel: "codex login",
        artifactLabel: "binary",
        resolveLogin: async () => ({
          ok: true as const,
          login: async () => {
            throw new Error("browser boom");
          },
        }),
        reprobe: async () => [
          { provider: "codex", entry: { state: "ok", available: true, detectedAt: "2026-06-22T12:00:00.000Z" } },
        ],
      },
    });

    const logs: string[] = [];
    await runRuntimeAuthLogin(
      { provider: "codex", ref: "default-codex-error" },
      {
        currentEntry: () => undefined,
        setProviderEntry: async () => undefined,
        log: (_symbol, message) => {
          logs.push(message);
        },
      },
    );

    expect(logs).toContain("runtime-auth: codex login threw: browser boom");
  });
});
