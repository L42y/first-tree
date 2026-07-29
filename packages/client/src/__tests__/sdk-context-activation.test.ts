import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK } from "../sdk.js";

describe("SDK Context activation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses member auth without an Agent selector and validates the response", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer member-token",
        "Content-Type": "application/json",
      });
      expect(init?.headers).not.toHaveProperty("X-Agent-Id");
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          outcome: "connected",
          team: {
            organizationId: "org_acme",
            displayName: "Acme",
            role: "member",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken: () => "member-token",
    });

    await expect(
      sdk.validateMemberContextActivation("org/acme ?", {
        schemaVersion: 1,
        repositoryKey: "github.com/acme/payments",
      }),
    ).resolves.toMatchObject({ outcome: "connected" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      schemaVersion: 1,
      repositoryKey: "github.com/acme/payments",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/orgs/org%2Facme%20%3F/context-activation/validate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses one attempt signal for token acquisition and the activation request", async () => {
    let tokenSignal: AbortSignal | undefined;
    const getAccessToken = vi.fn((options?: { signal?: AbortSignal }) => {
      tokenSignal = options?.signal;
      return "member-token";
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(tokenSignal);
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          outcome: "connected",
          team: {
            organizationId: "org_acme",
            displayName: "Acme",
            role: "member",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken,
    });

    await expect(
      sdk.validateMemberContextActivation(
        "org_acme",
        {
          schemaVersion: 1,
          repositoryKey: "github.com/acme/payments",
        },
        { retry: false, timeoutMs: 5_000 },
      ),
    ).resolves.toMatchObject({ outcome: "connected" });
    expect(tokenSignal).toBeInstanceOf(AbortSignal);
    expect(getAccessToken).toHaveBeenCalledWith({ signal: tokenSignal });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails on an unknown Server outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, outcome: "guessed" }), { status: 200 })),
    );
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken: () => "member-token",
    });
    await expect(
      sdk.validateMemberContextActivation("org_acme", {
        schemaVersion: 1,
        repositoryKey: "github.com/acme/payments",
      }),
    ).rejects.toThrow();
  });

  it("finishes one explicit membership without transport retry", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://first-tree.example/api/v1/me/onboarding-completed");
      expect(init).toMatchObject({ method: "POST" });
      expect(JSON.parse(String(init?.body))).toEqual({ organizationId: "org_acme" });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken: () => "member-token",
    });

    await expect(sdk.completeMemberOnboarding("org_acme")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads and validates the caller-owned Computer's live status", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "connected" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken: () => "member-token",
    });

    await expect(sdk.getOwnedClientStatus("client/one")).resolves.toEqual({ status: "connected" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/clients/client%2Fone",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer member-token" }),
      }),
    );
  });

  it("rejects an unknown Computer status instead of guessing readiness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "sleeping" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken: () => "member-token",
    });

    await expect(sdk.getOwnedClientStatus("client-1")).rejects.toThrow("invalid Computer status");
  });

  it("sends the Admin-confirmed repository batch without transport retry", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/api/v1/orgs/org_acme/resources/repositories/confirm");
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedActiveRepositoryKeys: [],
        repositories: [{ name: "App", url: "https://github.com/acme/app.git" }],
      });
      return new Response(JSON.stringify({ repositories: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken: () => "member-token",
    });
    await expect(
      sdk.confirmMemberTeamRepositories("org_acme", {
        expectedActiveRepositoryKeys: [],
        repositories: [{ name: "App", url: "https://github.com/acme/app.git" }],
      }),
    ).resolves.toEqual({ repositories: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
