// @vitest-environment happy-dom

import { type Agent, type CapabilityEntry, FEISHU_REQUIRED_SCOPES, type FeishuBotBinding } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import { ApiError } from "../../../api/client.js";
import type { ComputerConnection } from "../../../features/agent-setup/use-computer-connection.js";
import { OpenTagPage } from "../opentag-page.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const AGENT_UUID = "0198b2c4-1f6a-7c31-9a02-4d5e6f708192";
const ORG = "org-1";
const MEMBER = "member-1";

const refreshMeStrict = vi.hoisted(() => vi.fn(async () => undefined));
const applyOnboardingStamp = vi.hoisted(() => vi.fn(() => true));
const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
    memberId: "member-1" as string | null,
    role: "admin" as string | null,
    meAuthoritative: true,
    currentOrgHasPersonalAgent: true,
    refreshMeStrict,
    applyOnboardingStamp,
    logout: vi.fn(),
  },
}));
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));

const agentsApi = vi.hoisted(() => ({
  getAgent: vi.fn(),
  createAgent: vi.fn(),
  listManagedAgents: vi.fn(),
  getAgentFeishuBinding: vi.fn(),
  startAgentFeishuRegistration: vi.fn(),
  createAgentFeishuSetupChat: vi.fn(),
  completeAgentFeishuOnboarding: vi.fn(),
}));
vi.mock("../../../api/agents.js", () => agentsApi);

const activityApi = vi.hoisted(() => ({ startRuntimeAuth: vi.fn() }));
vi.mock("../../../api/activity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/activity.js")>()),
  startRuntimeAuth: activityApi.startRuntimeAuth,
}));

const computerMock = vi.hoisted((): { value: ComputerConnection } => ({ value: {} as ComputerConnection }));
vi.mock("../../../features/agent-setup/use-computer-connection.js", () => ({
  useComputerConnection: () => computerMock.value,
}));

function capability(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    state: "ok",
    available: true,
    detectedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function client(id = "client-1", hostname = "Studio Mac", capabilities = { codex: capability() }): HubClient {
  return {
    id,
    userId: "user-1",
    status: "connected",
    authState: "ok",
    binName: "first-tree",
    sdkVersion: "1.4.0",
    hostname,
    os: "darwin",
    agentCount: 0,
    connectedAt: "2026-08-14T00:00:00.000Z",
    lastSeenAt: "2026-08-14T00:00:00.000Z",
    capabilities,
  };
}

function computer(overrides: Partial<ComputerConnection> = {}): ComputerConnection {
  return {
    connectedClients: [],
    selectedClientId: null,
    setSelectedClientId: vi.fn(),
    connectedClient: null,
    capabilitiesLoaded: false,
    capabilities: null,
    okRuntimes: [],
    selectedRuntime: null,
    setSelectedRuntime: vi.fn(),
    cliCommand: "curl -fsSL https://download.first-tree.ai/install.sh | sh\n~/.local/bin/first-tree login CODE",
    tokenError: null,
    retry: vi.fn(),
    refreshCapabilities: vi.fn(),
    ...overrides,
  };
}

function readyComputer(capabilities = { codex: capability() }): ComputerConnection {
  const connected = client("client-1", "Studio Mac", capabilities);
  const okRuntimes = Object.entries(capabilities)
    .filter(([, entry]) => entry.state === "ok")
    .map(([provider]) => provider as "codex" | "claude-code");
  return computer({
    connectedClients: [connected],
    selectedClientId: connected.id,
    connectedClient: connected,
    capabilitiesLoaded: true,
    capabilities,
    okRuntimes,
    selectedRuntime: okRuntimes[0] ?? null,
  });
}

function agentRow(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: AGENT_UUID,
    name: "opentag",
    organizationId: ORG,
    type: "agent",
    displayName: "OpenTag",
    delegateMention: null,
    inboxId: "inbox-1",
    status: "active",
    visibility: "organization",
    metadata: {},
    managerId: MEMBER,
    clientId: "client-1",
    runtimeProvider: "codex",
    avatarColorToken: null,
    avatarImageUrl: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function binding(overrides: Partial<FeishuBotBinding> = {}): FeishuBotBinding {
  return {
    id: "binding-1",
    agentId: AGENT_UUID,
    appId: null,
    botName: null,
    botAvatarUrl: null,
    botOpenId: null,
    tenantKey: null,
    status: "provisioning",
    connectionStatus: "disconnected",
    grantedScopes: [],
    registrationUrl: "https://open.feishu.cn/register?code=test",
    registrationExpiresAt: null,
    lastConnectedAt: null,
    lastEventAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    cli: { state: "unknown", version: null, clientId: "client-1" },
    ...overrides,
  };
}

function usableBinding(): FeishuBotBinding {
  return binding({
    status: "active",
    connectionStatus: "connected",
    appId: "cli_1",
    botOpenId: "ou_bot",
    grantedScopes: [...FEISHU_REQUIRED_SCOPES],
    registrationUrl: null,
    cli: { state: "ready", version: "1.4.0", clientId: "client-1" },
  });
}

let root: Root | null = null;
let lastLocation = "";

function LocationProbe() {
  const location = useLocation();
  lastLocation = `${location.pathname}${location.search}${location.hash}`;
  return null;
}

async function flush(times = 5): Promise<void> {
  for (let index = 0; index < times; index++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderAt(route: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <LocationProbe />
          <Routes>
            <Route path="/opentag" element={<OpenTagPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
  if (!match) throw new Error(`No button matching ${label}. Saw: ${scope.textContent}`);
  return match;
}

function buttonExact(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  if (!match) throw new Error(`No exact button matching ${label}. Saw: ${scope.textContent}`);
  return match;
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
}

beforeEach(() => {
  authMock.value = {
    organizationId: ORG,
    memberId: MEMBER,
    role: "admin",
    meAuthoritative: true,
    currentOrgHasPersonalAgent: true,
    refreshMeStrict,
    applyOnboardingStamp,
    logout: vi.fn(),
  };
  refreshMeStrict.mockReset().mockResolvedValue(undefined);
  applyOnboardingStamp.mockReset().mockReturnValue(true);
  computerMock.value = computer();
  agentsApi.getAgent.mockReset().mockResolvedValue(agentRow());
  agentsApi.createAgent.mockReset();
  agentsApi.listManagedAgents.mockReset().mockResolvedValue([]);
  agentsApi.getAgentFeishuBinding.mockReset().mockResolvedValue({ binding: null });
  agentsApi.startAgentFeishuRegistration.mockReset().mockResolvedValue({ binding: binding() });
  agentsApi.createAgentFeishuSetupChat.mockReset().mockResolvedValue({ chatId: "setup-chat" });
  agentsApi.completeAgentFeishuOnboarding.mockReset().mockResolvedValue({ completedAt: "2026-08-14T00:05:00.000Z" });
  activityApi.startRuntimeAuth.mockReset().mockResolvedValue({ ref: "auth-ref", started: true });
  lastLocation = "";
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("OpenTag single-page Desktop flow", () => {
  it("shows the Computer blocker as the only product action and no retired wizard concepts", async () => {
    const container = await renderAt("/opentag");
    const state = container.querySelector("[data-opentag-state='connect-computer']");

    expect(container.querySelector("h1")?.textContent).toBe("Bring your agent to Feishu");
    expect(container.textContent).toContain("Your agentOpenTagChange name");
    expect(state?.textContent).toContain("Copy command");
    expect(state?.querySelectorAll("button")).toHaveLength(1);
    for (const retired of ["Template", "Step 1", "Continue", "Next", "First Tree Client", "progress"]) {
      expect(container.textContent).not.toContain(retired);
    }
  });

  it("keeps connect-command failures recoverable inside the Action surface", async () => {
    const retry = vi.fn();
    computerMock.value = computer({ cliCommand: null, tokenError: "Could not prepare the command.", retry });
    const container = await renderAt("/opentag");
    const action = container.querySelector("[data-opentag-state='connect-computer'] [data-opentag-action]");

    expect(action?.textContent).toContain("Could not prepare the command.");
    await click(button(action ?? container, "Try again"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("shows and starts concrete Codex sign-in recovery inside the Action surface", async () => {
    const caps = {
      codex: capability({ lastAuthError: { reason: "timeout", at: "2026-08-14T00:00:00.000Z" } }),
    };
    computerMock.value = readyComputer(caps);
    const container = await renderAt("/opentag");

    expect(container.querySelector("[data-opentag-state='agent-blocked']")?.textContent).toContain("Sign in to Codex");
    await click(button(container, "Sign in to Codex"));
    expect(activityApi.startRuntimeAuth).toHaveBeenCalledWith("client-1", { provider: "codex" });
    expect(agentsApi.createAgent).not.toHaveBeenCalled();
  });

  it("auto-selects a stable ready Agent, offers the lightweight picker, and creates once without a Template", async () => {
    const caps = {
      codex: capability(),
      "claude-code": capability(),
      cursor: capability({ state: "missing", available: false }),
    };
    computerMock.value = readyComputer(caps);
    agentsApi.createAgent.mockResolvedValue(agentRow());
    const container = await renderAt("/opentag");

    expect(container.textContent).toContain("Agent · Codex ready");
    expect(container.querySelector("[data-opentag-state='create-agent']")).not.toBeNull();
    await click(buttonExact(container, "Change"));
    expect(document.body.textContent).toContain("Claude Code");
    expect(document.body.textContent).toContain("Cursor");
    expect(document.body.textContent).toContain("Install required");
    expect(buttonExact(container, "Change").getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-opentag-statuses]")?.classList.contains("opentag-statuses")).toBe(true);

    await click(button(container, "Create agent"));
    expect(agentsApi.createAgent).toHaveBeenCalledTimes(1);
    expect(agentsApi.createAgent.mock.calls[0]?.[0]).toEqual({
      type: "agent",
      displayName: "OpenTag",
      name: "opentag",
      visibility: "organization",
      clientId: "client-1",
      runtimeProvider: "codex",
      organizationId: ORG,
    });
    expect(agentsApi.createAgent.mock.calls[0]?.[0]).not.toHaveProperty("templateIds");
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
  });

  it("lets the default display name be edited before the one durable click", async () => {
    computerMock.value = readyComputer();
    agentsApi.createAgent.mockResolvedValue(agentRow({ displayName: "Atlas", name: "atlas" }));
    agentsApi.getAgent.mockResolvedValue(agentRow({ displayName: "Atlas", name: "atlas" }));
    agentsApi.getAgentFeishuBinding.mockResolvedValue({ binding: binding() });
    const container = await renderAt("/opentag");
    await click(button(container, "Change name"));
    const input = container.querySelector<HTMLInputElement>("#opentag-agent-name");
    if (!input) throw new Error("missing name input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Atlas");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    await click(button(container, "Create agent"));
    expect(agentsApi.createAgent.mock.calls[0]?.[0]).toMatchObject({ displayName: "Atlas", name: "atlas" });
    expect(container.textContent).toContain("Add Atlas to Feishu");
    expect(container.textContent).toContain("add Atlas");
  });

  it("automatically starts Feishu registration after creation and renders QR with no Web CTA", async () => {
    computerMock.value = readyComputer();
    agentsApi.getAgent.mockResolvedValue(agentRow());
    const registration = binding();
    agentsApi.getAgentFeishuBinding
      .mockResolvedValueOnce({ binding: null })
      .mockResolvedValue({ binding: registration });
    agentsApi.startAgentFeishuRegistration.mockResolvedValue({ binding: registration });

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);
    expect(agentsApi.startAgentFeishuRegistration).toHaveBeenCalledWith(AGENT_UUID, "OpenTag");
    expect(container.querySelector("[data-opentag-state='add-to-feishu']")?.textContent).toContain("Scan with Feishu");
    expect(container.querySelector("[data-opentag-qr] title")?.textContent).toBe("Feishu bot registration QR code");
    expect(container.querySelector("[data-opentag-state='add-to-feishu']")?.querySelectorAll("button")).toHaveLength(0);
    expect(agentsApi.createAgentFeishuSetupChat).toHaveBeenCalledWith(AGENT_UUID, { retry: false });
  });

  it("automatically restarts a failed Feishu registration instead of stranding recovery", async () => {
    computerMock.value = readyComputer();
    agentsApi.getAgent.mockResolvedValue(agentRow());
    const failed = binding({
      status: "error",
      connectionStatus: "error",
      registrationUrl: null,
      lastErrorMessage: "Registration expired.",
    });
    const restarted = binding();
    agentsApi.getAgentFeishuBinding
      .mockResolvedValueOnce({ binding: failed })
      .mockResolvedValue({ binding: restarted });
    agentsApi.startAgentFeishuRegistration.mockResolvedValue({ binding: restarted });

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(agentsApi.startAgentFeishuRegistration).toHaveBeenCalledWith(AGENT_UUID, "OpenTag");
    expect(container.querySelector("[data-opentag-qr]")).not.toBeNull();
  });

  it("marks completion and advances as soon as Bot reachability and local tools are ready", async () => {
    computerMock.value = readyComputer();
    agentsApi.getAgent.mockResolvedValue(agentRow());
    agentsApi.getAgentFeishuBinding.mockResolvedValue({ binding: usableBinding() });
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(agentsApi.completeAgentFeishuOnboarding).toHaveBeenCalledWith(AGENT_UUID);
    expect(applyOnboardingStamp).toHaveBeenCalledWith("completed", "2026-08-14T00:05:00.000Z", {
      id: MEMBER,
      organizationId: ORG,
    });
    expect(container.querySelector("[data-opentag-state='ready']")?.textContent).toContain("Open Feishu");
    expect(
      container.querySelector<HTMLAnchorElement>(
        "[data-opentag-state='ready'] a[href='https://applink.feishu.cn/client/bot/open?appId=cli_1']",
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("first message");
    expect(container.textContent).not.toContain("first task is ready");
  });

  it("keeps the edited Agent name in the ready handoff", async () => {
    computerMock.value = readyComputer();
    agentsApi.getAgent.mockResolvedValue(agentRow({ displayName: "Atlas", name: "atlas" }));
    agentsApi.getAgentFeishuBinding.mockResolvedValue({ binding: usableBinding() });
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.querySelector("[data-opentag-state='ready']")?.textContent).toContain("Atlas is ready");
    expect(container.querySelector("[data-opentag-state='ready']")?.textContent).toContain(
      "Atlas is connected to Feishu",
    );
  });

  it("never starts owner-only Feishu writes when an admin views a teammate’s Agent", async () => {
    computerMock.value = readyComputer();
    agentsApi.getAgent.mockResolvedValue(agentRow({ managerId: "member-2" }));
    agentsApi.getAgentFeishuBinding.mockResolvedValue({ binding: null });
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.textContent).toContain("Only this agent’s owner can finish Feishu setup.");
    expect(container.querySelector("[data-opentag-state='add-to-feishu']")?.querySelectorAll("button")).toHaveLength(0);
    expect(agentsApi.startAgentFeishuRegistration).not.toHaveBeenCalled();
    expect(agentsApi.createAgentFeishuSetupChat).not.toHaveBeenCalled();
    expect(agentsApi.completeAgentFeishuOnboarding).not.toHaveBeenCalled();
  });

  it("keeps completion closed while only the Bot is ready and prepares tools automatically", async () => {
    computerMock.value = readyComputer();
    agentsApi.getAgent.mockResolvedValue(agentRow());
    agentsApi.getAgentFeishuBinding.mockResolvedValue({
      binding: binding({
        status: "active",
        connectionStatus: "connected",
        appId: "cli_1",
        botOpenId: "ou_bot",
        grantedScopes: [...FEISHU_REQUIRED_SCOPES],
        registrationUrl: null,
      }),
    });
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(agentsApi.completeAgentFeishuOnboarding).not.toHaveBeenCalled();
    expect(agentsApi.createAgentFeishuSetupChat).toHaveBeenCalledWith(AGENT_UUID, { retry: false });
    expect(container.querySelector("[data-opentag-state='add-to-feishu']")?.textContent).toContain(
      "Preparing Feishu tools",
    );
  });

  it("preserves the Agent URL through transient read failures and retries in place", async () => {
    agentsApi.getAgent.mockRejectedValue(new Error("offline"));
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
    expect(container.textContent).toContain("Nothing was lost");
    expect(container.textContent).not.toContain("Create agent");

    agentsApi.getAgent.mockResolvedValue(agentRow());
    await click(button(container, "Try again"));
    expect(agentsApi.getAgent).toHaveBeenCalledTimes(2);
  });

  it("rejects an unavailable URL Agent and recovers to the bare entry", async () => {
    agentsApi.getAgent.mockRejectedValue(new ApiError(404, "not found"));
    await renderAt(`/opentag?agent=${AGENT_UUID}`);
    expect(lastLocation).toBe("/opentag");
  });

  it("offers exact-handle recovery after a lost create response without silently adopting it", async () => {
    computerMock.value = readyComputer();
    agentsApi.createAgent.mockRejectedValue(new ApiError(409, "taken", undefined, "agent_name_conflict"));
    agentsApi.listManagedAgents.mockResolvedValue([
      {
        uuid: AGENT_UUID,
        name: "opentag",
        displayName: "OpenTag",
        type: "agent",
        organizationId: ORG,
        inboxId: "inbox-1",
        visibility: "organization",
        runtimeProvider: "codex",
        clientId: "client-1",
        status: "active",
        avatarImageUrl: null,
      },
    ]);
    const container = await renderAt("/opentag");
    await click(button(container, "Create agent"));
    expect(container.textContent).toContain("already exists");
    expect(button(container, "Use existing agent").closest("[data-opentag-action]")).not.toBeNull();
    expect(lastLocation).toBe("/opentag");
    await click(button(container, "Use existing agent"));
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
  });

  it("returns to the create action when the user changes a conflicting name", async () => {
    computerMock.value = readyComputer();
    agentsApi.createAgent.mockRejectedValue(new ApiError(409, "taken", undefined, "agent_name_conflict"));
    agentsApi.listManagedAgents.mockResolvedValue([
      {
        uuid: AGENT_UUID,
        name: "opentag",
        displayName: "OpenTag",
        type: "agent",
        organizationId: ORG,
        inboxId: "inbox-1",
        visibility: "organization",
        runtimeProvider: "codex",
        clientId: "client-1",
        status: "active",
        avatarImageUrl: null,
      },
    ]);
    const container = await renderAt("/opentag");
    await click(button(container, "Create agent"));
    await click(button(container, "Change name"));
    const input = container.querySelector<HTMLInputElement>("#opentag-agent-name");
    if (!input) throw new Error("missing name input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Atlas");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).not.toContain("Use existing agent");
    expect(button(container, "Create agent")).not.toBeNull();
  });
});
