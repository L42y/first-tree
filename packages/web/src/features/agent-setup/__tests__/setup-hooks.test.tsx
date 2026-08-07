// @vitest-environment happy-dom

import { enabledOkRuntimeProviders, pickPreferredRuntimeProvider } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentCreation } from "../use-agent-creation.js";
import { type ComputerConnection, useComputerConnection } from "../use-computer-connection.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  getClientCapabilities: vi.fn(),
  listClients: vi.fn(),
}));

const agentConfigMocks = vi.hoisted(() => ({
  getAgentClientStatus: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  api: {
    post: vi.fn(),
  },
  withOrg: vi.fn((path: string) => `/orgs/org-1${path}`),
}));

const eventMocks = vi.hoisted(() => ({
  reportOnboardingEvent: vi.fn(),
}));

const visibilityMocks = vi.hoisted(() => ({
  runVisibilityAwareInterval: vi.fn((tick: () => void | Promise<void>) => {
    void tick();
    return vi.fn();
  }),
}));

vi.mock("../../../api/activity.js", () => activityMocks);
vi.mock("../../../api/agent-config.js", () => agentConfigMocks);
vi.mock("../../../api/client.js", () => clientMocks);
vi.mock("../../../api/onboarding-events.js", () => eventMocks);
vi.mock("../../../lib/visibility-interval.js", () => visibilityMocks);

let root: Root | null = null;
const PROD_INSTALLER_URL = "https://download.first-tree.ai/releases/prod/install.sh";
const bootstrapCommand = (token: string): string =>
  `curl -fsSL ${PROD_INSTALLER_URL} | sh\n~/.local/bin/first-tree login ${token}`;

function expectHookValue<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("hook value was not captured");
  return value;
}

function latestVisibilityTick(): () => void | Promise<void> {
  const tick = visibilityMocks.runVisibilityAwareInterval.mock.calls.at(-1)?.[0];
  if (!tick) throw new Error("visibility-aware interval was not registered");
  return tick;
}

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderProbe(element: ReactNode, queryClient: QueryClient = testQueryClient()): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={["/test"]}>
        <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  const storage = createStorage();
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("shared setup hooks", () => {
  it("uses one Codex/Claude preference prefix and otherwise keeps Client order", () => {
    const ok = { state: "ok" as const };
    expect(enabledOkRuntimeProviders({ opencode: ok, "claude-code": ok, "future-provider": ok, codex: ok })).toEqual([
      "codex",
      "claude-code",
      "opencode",
    ]);
    expect(pickPreferredRuntimeProvider({ "claude-code": ok, codex: ok, opencode: ok })).toBe("codex");
    expect(pickPreferredRuntimeProvider({ "claude-code": ok, opencode: ok })).toBe("claude-code");
    expect(pickPreferredRuntimeProvider({ opencode: ok, "future-provider": ok })).toBe("opencode");
    expect(pickPreferredRuntimeProvider({})).toBeNull();
  });

  it("detects connected computers and picks a ready runtime without onboarding state", async () => {
    const latest = { current: null as ComputerConnection | null };
    const client = {
      id: "client-1",
      userId: "user-self",
      status: "connected",
      authState: "ok",
      binName: "first-tree-dev",
      sdkVersion: "0.5.0",
      hostname: "gandy-macbook",
      os: "darwin",
      agentCount: 1,
      connectedAt: "2026-05-28T00:00:00.000Z",
      lastSeenAt: "2026-05-28T12:00:00.000Z",
      capabilities: {},
    };
    activityMocks.listClients.mockResolvedValue([client]);
    activityMocks.getClientCapabilities.mockResolvedValue({
      ...client,
      capabilities: {
        codex: {
          state: "ok",
          available: true,
          authenticated: true,
          authMethod: "api_key",
          detectedAt: "2026-05-28T12:00:00.000Z",
        },
        "claude-code": {
          state: "unauthenticated",
          available: true,
          authenticated: false,
          authMethod: "none",
          detectedAt: "2026-05-28T12:00:00.000Z",
        },
      },
    });

    function Probe() {
      latest.current = useComputerConnection(true);
      return <div>{latest.current.selectedRuntime ?? "none"}</div>;
    }

    await renderProbe(<Probe />);
    await flush();
    await flush();

    expect(expectHookValue(latest.current).connectedClient?.id).toBe("client-1");
    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(true);
    expect(expectHookValue(latest.current).okRuntimes).toEqual(["codex"]);
    expect(expectHookValue(latest.current).selectedRuntime).toBe("codex");
    expect(sessionStorage.getItem("onboarding:agentUuid")).toBeNull();
    expect(eventMocks.reportOnboardingEvent).not.toHaveBeenCalled();
  });

  it("requires an explicit computer choice when multiple computers are connected", async () => {
    const latest: { current: ComputerConnection | null } = { current: null };
    const older = {
      id: "client-old",
      userId: "user-self",
      status: "connected",
      authState: "ok",
      binName: "first-tree-dev",
      sdkVersion: "0.5.0",
      hostname: "studio-mac",
      os: "darwin",
      agentCount: 1,
      connectedAt: "2026-05-28T00:00:00.000Z",
      lastSeenAt: "2026-05-28T11:00:00.000Z",
      capabilities: {},
    };
    const newer = {
      ...older,
      id: "client-new",
      hostname: "travel-mac",
      lastSeenAt: "2026-05-28T12:00:00.000Z",
    };
    activityMocks.listClients.mockResolvedValue([older, newer]);
    activityMocks.getClientCapabilities.mockImplementation(async (clientId: string) => ({
      ...(clientId === older.id ? older : newer),
      capabilities:
        clientId === older.id
          ? {
              "claude-code": {
                state: "ok",
                available: true,
                detectedAt: "2026-05-28T12:00:00.000Z",
              },
            }
          : {
              codex: {
                state: "ok",
                available: true,
                detectedAt: "2026-05-28T12:00:00.000Z",
              },
              "claude-code": {
                state: "ok",
                available: true,
                detectedAt: "2026-05-28T12:00:00.000Z",
              },
            },
    }));

    function Probe() {
      latest.current = useComputerConnection(true, { requireExplicitSelectionWhenMultiple: true });
      return <div>{latest.current.selectedClientId ?? "choose"}</div>;
    }

    await renderProbe(<Probe />);
    await flush();
    await flush();

    expect(expectHookValue(latest.current).connectedClients.map((client) => client.id)).toEqual([
      "client-new",
      "client-old",
    ]);
    expect(expectHookValue(latest.current).selectedClientId).toBeNull();
    expect(expectHookValue(latest.current).connectedClient).toBeNull();
    expect(activityMocks.getClientCapabilities).not.toHaveBeenCalled();

    await act(async () => expectHookValue(latest.current).setSelectedClientId("client-old"));
    await flush();
    await flush();

    expect(expectHookValue(latest.current).connectedClient?.id).toBe("client-old");
    expect(activityMocks.getClientCapabilities).toHaveBeenCalledWith("client-old");
    expect(expectHookValue(latest.current).selectedRuntime).toBe("claude-code");

    await act(async () => expectHookValue(latest.current).setSelectedClientId("client-new"));
    await flush();
    await flush();
    expect(expectHookValue(latest.current).selectedRuntime).toBe("codex");

    await act(async () => expectHookValue(latest.current).setSelectedRuntime("claude-code"));
    await act(async () => expectHookValue(latest.current).setSelectedClientId("client-old"));
    await flush();
    await flush();
    await act(async () => expectHookValue(latest.current).setSelectedClientId("client-new"));
    await flush();
    await flush();
    expect(expectHookValue(latest.current).selectedRuntime).toBe("claude-code");
  });

  it("keeps an empty capability snapshot in detecting state until a provider report arrives", async () => {
    const latest = { current: null as ComputerConnection | null };
    const client = {
      id: "client-1",
      userId: "user-self",
      status: "connected",
      authState: "ok",
      binName: "first-tree-dev",
      sdkVersion: "0.5.0",
      hostname: "gandy-macbook",
      os: "darwin",
      agentCount: 0,
      connectedAt: "2026-05-28T00:00:00.000Z",
      lastSeenAt: "2026-05-28T12:00:00.000Z",
      capabilities: {},
    };
    activityMocks.listClients.mockResolvedValue([client]);
    activityMocks.getClientCapabilities.mockResolvedValue({ ...client, capabilities: {} });

    function Probe() {
      latest.current = useComputerConnection(true);
      return <div>{latest.current.selectedRuntime ?? "none"}</div>;
    }

    await renderProbe(<Probe />);
    await flush();
    await flush();

    expect(expectHookValue(latest.current).connectedClient?.id).toBe("client-1");
    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(false);
    expect(expectHookValue(latest.current).okRuntimes).toEqual([]);
    expect(expectHookValue(latest.current).selectedRuntime).toBeNull();

    activityMocks.getClientCapabilities.mockResolvedValue({
      ...client,
      capabilities: {
        codex: {
          state: "ok",
          available: true,
          authenticated: true,
          authMethod: "none",
          detectedAt: "2026-05-28T12:00:05.000Z",
        },
      },
    });
    const tick = latestVisibilityTick();
    await act(async () => {
      await tick();
    });
    await flush();

    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(true);
    expect(expectHookValue(latest.current).okRuntimes).toEqual(["codex"]);
    expect(expectHookValue(latest.current).selectedRuntime).toBe("codex");
  });

  it("skips disabled/unknown providers and keeps a still-valid prior selection", async () => {
    const latest = { current: null as ComputerConnection | null };
    const client = {
      id: "client-1",
      userId: "user-self",
      status: "connected",
      authState: "ok",
      binName: "first-tree-dev",
      sdkVersion: "0.5.0",
      hostname: "gandy-macbook",
      os: "darwin",
      agentCount: 0,
      connectedAt: "2026-05-28T00:00:00.000Z",
      lastSeenAt: "2026-05-28T12:00:00.000Z",
      capabilities: {},
    };
    const ok = {
      state: "ok" as const,
      available: true,
      detectedAt: "2026-05-28T12:00:00.000Z",
    };
    activityMocks.listClients.mockResolvedValue([client]);
    activityMocks.getClientCapabilities.mockRejectedValue(new Error("capabilities offline"));

    function Probe() {
      latest.current = useComputerConnection(true);
      return <div>{latest.current.selectedRuntime ?? "none"}</div>;
    }

    await renderProbe(<Probe />);
    await flush();
    await flush();

    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(false);

    activityMocks.getClientCapabilities.mockResolvedValue({
      ...client,
      capabilities: {
        // Disabled known provider + unknown wire id — neither is selectable.
        "claude-code-tui": ok,
        "future-provider": ok,
      },
    });
    const tick = latestVisibilityTick();
    await act(async () => {
      await tick();
    });
    await flush();

    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(true);
    expect(expectHookValue(latest.current).okRuntimes).toEqual([]);
    expect(expectHookValue(latest.current).selectedRuntime).toBeNull();

    activityMocks.getClientCapabilities.mockResolvedValueOnce({
      ...client,
      capabilities: {
        pi: ok,
        "kimi-code": ok,
        grok: ok,
        "future-provider": ok,
      },
    });
    await act(async () => {
      await tick();
    });
    await flush();

    expect(expectHookValue(latest.current).okRuntimes).toEqual(["pi", "kimi-code", "grok"]);
    expect(expectHookValue(latest.current).selectedRuntime).toBe("pi");

    await act(async () => expectHookValue(latest.current).setSelectedRuntime("kimi-code"));
    activityMocks.getClientCapabilities.mockResolvedValueOnce({
      ...client,
      capabilities: {
        pi: ok,
        "kimi-code": ok,
        grok: ok,
        codex: ok,
      },
    });
    await act(async () => {
      await tick();
    });
    await flush();

    // Still-valid manual pick is preserved even when a higher-priority runtime appears.
    expect(expectHookValue(latest.current).selectedRuntime).toBe("kimi-code");
    expect(expectHookValue(latest.current).okRuntimes).toEqual(["codex", "pi", "kimi-code", "grok"]);
  });

  it("mints connect commands, surfaces final token failures, and retries manually", async () => {
    const latest = { current: null as ComputerConnection | null };
    const onTokenMintFailed = vi.fn();
    activityMocks.listClients.mockResolvedValue([]);
    clientMocks.api.post
      .mockResolvedValueOnce({
        token: "token-1",
        expiresIn: 600,
        command: "first-tree login token-1",
        bootstrapCommand: bootstrapCommand("token-1"),
        installerUrl: PROD_INSTALLER_URL,
        binName: "first-tree",
      })
      .mockRejectedValueOnce(new Error("token retry failed"))
      .mockRejectedValueOnce("still down")
      .mockRejectedValueOnce(new Error("token failed"))
      .mockResolvedValueOnce({
        token: "token-2",
        expiresIn: 600,
        command: "first-tree login token-2",
        bootstrapCommand: bootstrapCommand("token-2"),
        installerUrl: PROD_INSTALLER_URL,
        binName: "first-tree",
      });

    function Probe() {
      latest.current = useComputerConnection(true, { onTokenMintFailed });
      return <div>{latest.current.cliCommand ?? latest.current.tokenError ?? "pending"}</div>;
    }

    await renderProbe(<Probe />);
    await flush();
    await flush();

    expect(expectHookValue(latest.current).cliCommand).toBe(bootstrapCommand("token-1"));

    await act(async () => expectHookValue(latest.current).retry());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2400));
    });

    expect(expectHookValue(latest.current).tokenError).toBe("token failed");
    expect(onTokenMintFailed).toHaveBeenCalledTimes(1);

    await act(async () => expectHookValue(latest.current).retry());
    await flush();
    await flush();

    expect(expectHookValue(latest.current).cliCommand).toBe(bootstrapCommand("token-2"));
    expect(expectHookValue(latest.current).tokenError).toBeNull();
  }, 10_000);

  it("creates an agent and reports lifecycle through callbacks only", async () => {
    const latest = { current: null as ReturnType<typeof useAgentCreation> | null };
    const onOnline = vi.fn();
    const onCreated = vi.fn();
    const queryClient = testQueryClient();
    const rosterKey = ["agents", "org-list", { addressableOnly: true }] as const;
    queryClient.setQueryData(rosterKey, {
      items: [{ uuid: "human-agent-self", type: "human", delegateMention: null }],
      nextCursor: null,
    });
    clientMocks.api.post.mockResolvedValueOnce({ uuid: "agent-created" });
    agentConfigMocks.getAgentClientStatus
      .mockResolvedValueOnce({ online: false })
      .mockResolvedValueOnce({ online: true });

    function Probe() {
      latest.current = useAgentCreation({ onCreated, onOnline });
      return <div>{latest.current.phase}</div>;
    }

    await renderProbe(<Probe />, queryClient);
    await act(async () => {
      await expectHookValue(latest.current).create({
        displayName: "Deploy Bot",
        clientId: "client-1",
        runtimeProvider: "claude-code",
        visibility: "organization",
        organizationId: "org-1",
      });
    });

    expect(clientMocks.api.post).toHaveBeenCalledWith(
      "/orgs/org-1/agents",
      expect.objectContaining({
        displayName: "Deploy Bot",
        name: "deploy-bot",
        clientId: "client-1",
        runtimeProvider: "claude-code",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith({
      agentUuid: "agent-created",
      args: expect.objectContaining({ runtimeProvider: "claude-code" }),
    });
    expect(onOnline).toHaveBeenCalledWith("agent-created");
    expect(queryClient.getQueryState(rosterKey)?.isInvalidated).toBe(true);
    expect(expectHookValue(latest.current).phase).toBe("online");
    expect(sessionStorage.getItem("onboarding:agentUuid")).toBeNull();
    expect(eventMocks.reportOnboardingEvent).not.toHaveBeenCalled();
  });

  it("passes optional templateIds through to the create POST verbatim", async () => {
    const latest = { current: null as ReturnType<typeof useAgentCreation> | null };
    const queryClient = testQueryClient();
    clientMocks.api.post.mockResolvedValueOnce({ uuid: "agent-created" });
    agentConfigMocks.getAgentClientStatus.mockResolvedValueOnce({ online: true });

    function Probe() {
      latest.current = useAgentCreation({});
      return <div>{latest.current.phase}</div>;
    }

    await renderProbe(<Probe />, queryClient);
    await act(async () => {
      await expectHookValue(latest.current).create({
        displayName: "Deploy Bot",
        clientId: "client-1",
        runtimeProvider: "claude-code",
        visibility: "organization",
        organizationId: "org-1",
        templateIds: ["0190f000-0000-7000-8000-000000000001"],
      });
    });

    expect(clientMocks.api.post).toHaveBeenCalledWith(
      "/orgs/org-1/agents",
      expect.objectContaining({ templateIds: ["0190f000-0000-7000-8000-000000000001"] }),
    );

    // An empty selection stays omitted — identical to a plain create.
    clientMocks.api.post.mockResolvedValueOnce({ uuid: "agent-created-2" });
    agentConfigMocks.getAgentClientStatus.mockResolvedValueOnce({ online: true });
    await act(async () => {
      await expectHookValue(latest.current).create({
        displayName: "Deploy Bot",
        clientId: "client-1",
        runtimeProvider: "claude-code",
        visibility: "organization",
        organizationId: "org-1",
        templateIds: [],
      });
    });
    const secondBody = clientMocks.api.post.mock.calls[1]?.[1] as Record<string, unknown>;
    expect("templateIds" in secondBody).toBe(false);
  });
});
