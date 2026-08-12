import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK } from "../cloud/sdk.js";

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

  it("sends the repository-independent v2 contract", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ schemaVersion: 2 });
      return new Response(
        JSON.stringify({
          schemaVersion: 2,
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

    await expect(sdk.validateMemberContextActivation("org_acme", { schemaVersion: 2 })).resolves.toMatchObject({
      schemaVersion: 2,
      outcome: "connected",
    });
  });

  it("rejects a legacy response for a v2 activation request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
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
          ),
      ),
    );
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken: () => "member-token",
    });

    await expect(sdk.validateMemberContextActivation("org_acme", { schemaVersion: 2 })).rejects.toThrow();
  });

  it("batch-validates only the explicit BYO routing candidate ids", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://first-tree.example/api/v1/me/context-activation/candidates/validate");
      expect(JSON.parse(String(init?.body))).toEqual({ schemaVersion: 1, organizationIds: ["org_a", "org_b"] });
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          candidates: [
            {
              organizationId: "org_a",
              outcome: "connected",
              team: { organizationId: "org_a", displayName: "A", role: "member" },
              binding: { provider: "github", repo: "https://github.com/acme/tree", branch: "main" },
            },
            {
              organizationId: "org_b",
              outcome: "unavailable",
              reasonCode: "not_member",
              message: "Membership unavailable.",
            },
          ],
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
      sdk.validateMemberContextRouteCandidates(
        { schemaVersion: 1, organizationIds: ["org_a", "org_b"] },
        { retry: false },
      ),
    ).resolves.toMatchObject({ candidates: [{ organizationId: "org_a" }, { organizationId: "org_b" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("issues and validates an opaque session-only candidate", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith("/issue")) {
        expect(body).toMatchObject({ schemaVersion: 1, provider: "codex", organizationId: "org_a" });
        return new Response(JSON.stringify({ schemaVersion: 1, receipt: "x".repeat(40) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      expect(body).toMatchObject({ schemaVersion: 1, provider: "codex", receipt: "x".repeat(40) });
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          candidates: [
            {
              organizationId: "org_a",
              outcome: "connected",
              team: { organizationId: "org_a", displayName: "A", role: "member" },
              binding: { provider: "github", repo: "https://github.com/acme/tree", branch: "main" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken: () => "member-token",
    });
    const project = { kind: "path" as const, root: "/tmp/session" };
    const issued = await sdk.issueMemberContextSessionCandidate({
      schemaVersion: 1,
      provider: "codex",
      project,
      organizationId: "org_a",
    });
    await expect(
      sdk.validateMemberContextSessionCandidate({
        schemaVersion: 1,
        provider: "codex",
        project,
        receipt: issued.receipt,
      }),
    ).resolves.toMatchObject({ candidates: [{ organizationId: "org_a" }] });
    expect(calls).toEqual([
      "https://first-tree.example/api/v1/me/context-activation/session-candidate/issue",
      "https://first-tree.example/api/v1/me/context-activation/session-candidate/validate",
    ]);
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
