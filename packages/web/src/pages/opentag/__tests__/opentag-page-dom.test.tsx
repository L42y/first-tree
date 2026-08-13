// @vitest-environment happy-dom

import type { Agent, FeishuBotBinding } from "@first-tree/shared";
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
const TEMPLATE_ID = "0198b2c4-1f6a-7c31-9a02-4d5e6f708100";
const ORG = "org-1";
const MEMBER = "member-1";

const refreshMe = vi.hoisted(() => vi.fn(async () => undefined));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: null as string | null,
    meAuthoritative: true,
    memberId: null as string | null,
    role: null as string | null,
    user: { username: "ada" },
    logout: () => undefined,
    refreshMe,
  },
}));
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));

const api = vi.hoisted(() => ({
  getAgent: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  listManagedAgents: vi.fn(),
  getAgentFeishuBinding: vi.fn(),
  startAgentFeishuRegistration: vi.fn(),
}));
vi.mock("../../../api/agents.js", () => api);

const templates = vi.hoisted(() => ({ listAgentTemplates: vi.fn() }));
vi.mock("../../../api/agent-templates.js", () => templates);

const computerMock = vi.hoisted((): { value: ComputerConnection } => ({ value: {} as ComputerConnection }));
vi.mock("../../../features/agent-setup/use-computer-connection.js", () => ({
  useComputerConnection: () => computerMock.value,
}));

function client(id: string, hostname: string): HubClient {
  return {
    id,
    userId: "user-1",
    status: "connected",
    authState: "ok",
    binName: "first-tree",
    sdkVersion: "0.5.20",
    hostname,
    os: "darwin",
    agentCount: 0,
    connectedAt: "2026-08-13T00:00:00.000Z",
    lastSeenAt: "2026-08-13T00:00:00.000Z",
    capabilities: {},
  };
}

function computerConnection(overrides: Partial<ComputerConnection> = {}): ComputerConnection {
  return {
    connectedClients: [],
    selectedClientId: null,
    setSelectedClientId: vi.fn(),
    connectedClient: null,
    capabilitiesLoaded: false,
    okRuntimes: [],
    selectedRuntime: null,
    setSelectedRuntime: vi.fn(),
    cliCommand: "curl -fsSL https://example.test/install.sh | sh\n~/.local/bin/first-tree login CODE-123",
    tokenError: null,
    retry: vi.fn(),
    ...overrides,
  };
}

function feishuBinding(overrides: Partial<FeishuBotBinding> = {}): FeishuBotBinding {
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
    registrationUrl: null,
    registrationExpiresAt: null,
    lastConnectedAt: null,
    lastEventAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    cli: { state: "unknown", version: null, clientId: null },
    ...overrides,
  };
}

function readyComputer(): ComputerConnection {
  return computerConnection({
    connectedClients: [client("client-1", "Studio Mac")],
    selectedClientId: "client-1",
    connectedClient: client("client-1", "Studio Mac"),
    capabilitiesLoaded: true,
    okRuntimes: ["codex"],
    selectedRuntime: "codex",
  });
}

function agentRow(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: AGENT_UUID,
    name: "ada-assistant",
    organizationId: ORG,
    type: "agent",
    displayName: "Ada assistant",
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
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

let root: Root | null = null;
let lastLocation = "";

function LocationProbe() {
  lastLocation = `${useLocation().pathname}${useLocation().search}`;
  return null;
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
  if (!match) throw new Error(`No button matching "${label}". Saw: ${container.textContent}`);
  return match;
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  authMock.value = {
    organizationId: ORG,
    meAuthoritative: true,
    memberId: MEMBER,
    role: "admin",
    user: { username: "ada" },
    logout: () => undefined,
    refreshMe,
  };
  refreshMe.mockClear();
  computerMock.value = computerConnection();
  api.getAgent.mockReset();
  api.createAgent.mockReset();
  api.updateAgent.mockReset();
  api.listManagedAgents.mockReset().mockResolvedValue([]);
  api.getAgentFeishuBinding.mockReset().mockResolvedValue({ binding: null });
  api.startAgentFeishuRegistration.mockReset().mockResolvedValue({ binding: null });
  templates.listAgentTemplates.mockReset().mockResolvedValue({
    templates: [
      {
        id: TEMPLATE_ID,
        slug: "team-assistant",
        name: "Team Assistant",
        status: "active",
        public: {
          tagline: "For team questions, decisions, and follow-through.",
          purpose: "p",
          targetUsers: "t",
          userValue: "v",
          instructionsSummary: "i",
          toolsAndSkillsSummary: "s",
          exampleTasks: ["Summarize today's decisions for the wider team"],
        },
        updatedAt: "2026-08-13T00:00:00.000Z",
        replacement: null,
      },
    ],
  });
  lastLocation = "";
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("OpenTag entry — choosing the Agent", () => {
  it("creates nothing until the Computer is known, then creates it all at once", async () => {
    computerMock.value = readyComputer();
    api.createAgent.mockResolvedValue(agentRow());
    api.getAgent.mockResolvedValue(agentRow());
    const container = await renderAt("/opentag");

    expect(container.textContent).toContain("Team Assistant");
    // No Team, visibility, or Computer decision belongs on this step.
    expect(container.textContent).not.toContain("Visible to your team");
    expect(container.textContent).not.toContain("Choose a computer");

    await click(button(container, "Review Agent"));
    // One primary decision per screen: the name only appears after the
    // teammate is chosen.
    expect(container.textContent).toContain("Name your Agent");
    await click(button(container, "Continue"));

    // Still nothing persisted — the Computer decision comes first.
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(lastLocation).toBe("/opentag");
    expect(container.textContent).toContain("Studio Mac");

    await click(button(container, "Create Agent"));

    // One call carries the Template, the visibility, the Computer and the
    // runtime that Computer reported ready.
    expect(api.createAgent).toHaveBeenCalledTimes(1);
    expect(api.createAgent.mock.calls[0]?.[0]).toMatchObject({
      type: "agent",
      displayName: "ada assistant",
      name: "ada-assistant",
      visibility: "organization",
      templateIds: [TEMPLATE_ID],
      organizationId: ORG,
      clientId: "client-1",
      runtimeProvider: "codex",
    });
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(refreshMe).toHaveBeenCalled();
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
  });

  it("leaves nothing behind when the member turns back before creating", async () => {
    computerMock.value = readyComputer();
    const container = await renderAt("/opentag");
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));
    await click(button(container, "Choose a different teammate"));

    expect(container.textContent).toContain("What should it do?");
    expect(api.createAgent).not.toHaveBeenCalled();
  });

  it("offers the Agent a lost create response already made, without adopting it silently", async () => {
    // The first POST committed and its response was lost; the member pressed
    // Confirm again. The unique handle turns that into a conflict, and the
    // Agent this member already manages under that handle is offered by name.
    api.createAgent.mockRejectedValue(
      new ApiError(409, "Agent name is already taken", undefined, "agent_name_conflict"),
    );
    api.listManagedAgents.mockResolvedValue([
      // Same handle, but unusable — must not be offered.
      { ...agentRow(), name: "ada-assistant", displayName: "Old private", visibility: "private" },
      { ...agentRow(), name: "ada-assistant", displayName: "Ada assistant" },
    ]);

    computerMock.value = readyComputer();
    const container = await renderAt("/opentag");
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));
    await click(button(container, "Create Agent"));

    expect(api.createAgent).toHaveBeenCalledTimes(1);
    expect(api.createAgent.mock.calls[0]?.[0]).toMatchObject({ name: "ada-assistant" });
    // Nothing moved on its own.
    expect(lastLocation).toBe("/opentag");
    expect(container.textContent).toContain("already taken");

    // Creating and continuing are mutually exclusive, so they share one
    // pending state rather than both being live at once.
    expect(button(container, "Create Agent").disabled).toBe(false);

    await click(button(container, "Continue with Ada assistant"));
    // Readiness is refreshed before moving, or a fast visit to `/` bounces the
    // member into `/onboarding` for an Agent they already have.
    expect(refreshMe).toHaveBeenCalled();
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
  });

  it("does not offer a same-handle Agent this flow could not continue with", async () => {
    api.createAgent.mockRejectedValue(
      new ApiError(409, "Agent name is already taken", undefined, "agent_name_conflict"),
    );
    // Suspended, private, and never-bound Agents all share the handle; none of
    // them would survive the eligibility check on the next screen.
    api.listManagedAgents.mockResolvedValue([
      { ...agentRow(), name: "ada-assistant", displayName: "Suspended one", status: "suspended" },
      { ...agentRow(), name: "ada-assistant", displayName: "Private one", visibility: "private" },
      { ...agentRow(), name: "ada-assistant", displayName: "Unbound one", clientId: null },
    ]);
    computerMock.value = readyComputer();

    const container = await renderAt("/opentag");
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));
    await click(button(container, "Create Agent"));

    expect(container.textContent).toContain("already taken");
    expect(container.textContent).not.toContain("Continue with");
    expect(lastLocation).toBe("/opentag");
  });

  it("does not carry the draft into an Agent that turns out to be unusable", async () => {
    // A recovered-then-rejected Agent used to land back on the create step with
    // the old draft, straight into the same conflict.
    computerMock.value = readyComputer();
    api.createAgent.mockResolvedValue(agentRow());
    api.getAgent.mockResolvedValue(agentRow({ status: "suspended" }));

    const container = await renderAt("/opentag");
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));
    await click(button(container, "Create Agent"));

    expect(container.textContent).toContain("isn't available in this team anymore");
    expect(container.textContent).toContain("What should it do?");
    expect(container.textContent).not.toContain("Create Agent");

    // The rejected Agent leaves the URL, so the restart it advertises can
    // actually reach the Computer step instead of looping on the first screen.
    expect(lastLocation).toBe("/opentag");
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));
    expect(container.textContent).toContain("Studio Mac");
  });

  it("surfaces a name clash it cannot attribute to this member", async () => {
    // The colliding Agent belongs to a teammate, so `/me/managed-agents` does
    // not contain it and the server's own message is the honest answer.
    api.createAgent.mockRejectedValue(
      new ApiError(409, "Agent name is already taken", undefined, "agent_name_conflict"),
    );
    api.listManagedAgents.mockResolvedValue([]);

    computerMock.value = readyComputer();
    const container = await renderAt("/opentag");
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));
    await click(button(container, "Create Agent"));

    expect(container.textContent).toContain("already taken");
    expect(container.textContent).not.toContain("Continue with Ada");
    expect(lastLocation).toBe("/opentag");
  });

  it("replaces a malformed Agent target with the bare entry instead of retrying forever", async () => {
    // Only the canonical URL this app builds is acted on: `?agent=not-a-uuid`
    // would otherwise drive a read that can only fail.
    const container = await renderAt("/opentag?agent=not-a-uuid");

    expect(lastLocation).toBe("/opentag");
    expect(api.getAgent).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Team Assistant");
  });

  it("offers a team retry instead of creating against a guessed Team", async () => {
    // `meLoaded` flips after a `/me` transport failure too, so an
    // unauthoritative snapshot must not unlock Team-scoped creation.
    authMock.value = { ...authMock.value, meAuthoritative: false };
    const container = await renderAt("/opentag");

    expect(container.textContent).toContain("couldn't load your team");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Confirm Agent"))).toBe(false);
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Review Agent"))).toBe(false);
    // The guided path stays visible while it recovers.
    expect(container.querySelector("nav[aria-label='Guided handoff']")).not.toBeNull();
  });

  it("keeps the guided path visible while an Agent read is failing", async () => {
    api.getAgent.mockRejectedValue(new ApiError(500, "boom"));
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    // The fault replaces the step's content; the rail does not disappear.
    expect(container.querySelector("nav[aria-label='Guided handoff']")).not.toBeNull();
    expect(container.textContent).toContain("Add to Feishu");
  });

  it("recovers to the Agent choice for a private Agent rather than a Feishu write the server refuses", async () => {
    api.getAgent.mockResolvedValue(agentRow({ visibility: "private", clientId: "client-1" }));
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.textContent).toContain("isn't available in this team anymore");
    expect(container.textContent).not.toContain("Feishu Bot for");
  });

  it("recovers to the Agent choice for a suspended Agent rather than a step it cannot finish", async () => {
    // The first bind refuses a suspended Agent, so advancing to Runtime would
    // guarantee a rejection the member cannot act on here.
    api.getAgent.mockResolvedValue(agentRow({ status: "suspended" }));
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.textContent).toContain("isn't available in this team anymore");
    expect(container.textContent).not.toContain("Waiting for your computer to connect");
  });

  it("recovers to the Agent choice when the Agent in the URL is gone", async () => {
    api.getAgent.mockRejectedValue(new ApiError(404, "Agent not found"));
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.textContent).toContain("isn't available in this team anymore");
    expect(container.textContent).toContain("Team Assistant");
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(lastLocation).toBe("/opentag");
  });

  it("does not carry a recovery candidate into a different Template decision", async () => {
    api.createAgent.mockRejectedValue(
      new ApiError(409, "Agent name is already taken", undefined, "agent_name_conflict"),
    );
    api.listManagedAgents.mockResolvedValue([{ ...agentRow(), name: "ada-assistant", displayName: "Ada assistant" }]);
    computerMock.value = readyComputer();

    const container = await renderAt("/opentag");
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));
    await click(button(container, "Create Agent"));
    expect(container.textContent).toContain("Continue with Ada assistant");

    // Changing the decision invalidates what the previous one produced.
    await click(button(container, "Choose a different teammate"));
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));

    expect(container.textContent).not.toContain("Continue with Ada assistant");
    expect(container.textContent).not.toContain("already taken");
  });

  it("keeps the Agent and offers a retry when the read fails for an unrelated reason", async () => {
    api.getAgent.mockRejectedValue(new ApiError(500, "boom"));
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.textContent).toContain("We couldn't load your Agent");
    // The flow must not restart — a second Agent would be the real damage.
    expect(container.textContent).not.toContain("Team Assistant");
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
  });

  it("keeps the Agent retryable when the read fails without an HTTP status", async () => {
    // Offline / DNS / CORS: a plain Error, no status. Rendering nothing here
    // would strand the member on a blank page.
    api.getAgent.mockRejectedValue(new Error("Failed to fetch"));
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.textContent).toContain("We couldn't load your Agent");
    // The flow must not restart — a second Agent would be the real damage.
    expect(container.textContent).not.toContain("Team Assistant");
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
  });
});

describe("OpenTag entry — choosing the Computer", () => {
  /** Walk the draft steps: Template -> review -> the Computer choice. */
  async function atComputerStep(): Promise<HTMLElement> {
    const container = await renderAt("/opentag");
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));
    return container;
  }

  it("shows the server-authored connect command when no Computer is connected", async () => {
    const container = await atComputerStep();

    expect(container.textContent).toContain("first-tree login CODE-123");
    expect(container.textContent).toContain("Waiting for your computer to connect");
    expect(api.createAgent).not.toHaveBeenCalled();

    // Waiting for a Computer is the longest first-run state; the way back to
    // the teammate choice has to be reachable from it.
    await click(button(container, "Choose a different teammate"));
    expect(container.textContent).toContain("What should it do?");
  });

  it("recommends a sole connected Computer and creates the Agent on it", async () => {
    computerMock.value = readyComputer();
    api.createAgent.mockResolvedValue(agentRow());
    api.getAgent.mockResolvedValue(agentRow());

    const container = await atComputerStep();
    expect(container.textContent).toContain("Studio Mac");

    await click(button(container, "Create Agent"));

    expect(api.createAgent.mock.calls[0]?.[0]).toMatchObject({ clientId: "client-1", runtimeProvider: "codex" });
    expect(container.textContent).toContain("Feishu Bot for Ada assistant");
  });

  it("requires an explicit choice between several Computers, then creates on the chosen one", async () => {
    computerMock.value = computerConnection({
      connectedClients: [client("client-1", "Studio Mac"), client("client-2", "MacBook Pro")],
      selectedClientId: null,
    });

    const container = await atComputerStep();
    expect(container.textContent).toContain("Choose a computer");
    // Nothing is pinned from heartbeat order.
    expect(button(container, "Create Agent").disabled).toBe(true);
    expect(api.createAgent).not.toHaveBeenCalled();

    computerMock.value = computerConnection({
      connectedClients: [client("client-1", "Studio Mac"), client("client-2", "MacBook Pro")],
      selectedClientId: "client-2",
      connectedClient: client("client-2", "MacBook Pro"),
      capabilitiesLoaded: true,
      okRuntimes: ["codex"],
      selectedRuntime: "codex",
    });
    api.createAgent.mockResolvedValue(agentRow());
    api.getAgent.mockResolvedValue(agentRow());
    const chosen = await atComputerStep();
    await click(button(chosen, "Create Agent"));

    expect(api.createAgent.mock.calls[0]?.[0]).toMatchObject({ clientId: "client-2", runtimeProvider: "codex" });
    expect(chosen.textContent).toContain("Feishu Bot for Ada assistant");
  });

  it("does not offer to create on a Computer with no coding agent", async () => {
    computerMock.value = computerConnection({
      connectedClients: [client("client-1", "Studio Mac")],
      selectedClientId: "client-1",
      connectedClient: client("client-1", "Studio Mac"),
      capabilitiesLoaded: true,
      okRuntimes: [],
      selectedRuntime: null,
    });

    const container = await atComputerStep();
    expect(container.textContent).toContain("No coding agent is installed on this computer yet");
    expect(button(container, "Create Agent").disabled).toBe(true);
    expect(api.createAgent).not.toHaveBeenCalled();
  });

  it("keeps a failed create on this step and retryable, with nothing created", async () => {
    computerMock.value = readyComputer();
    api.createAgent.mockRejectedValue(new ApiError(400, 'Client "client-1" does not have runtime provider'));

    const container = await atComputerStep();
    await click(button(container, "Create Agent"));

    expect(container.textContent).toContain("does not have runtime provider");
    expect(container.textContent).not.toContain("Feishu Bot for");
    expect(button(container, "Create Agent").disabled).toBe(false);
    expect(lastLocation).toBe("/opentag");
  });
});

describe("OpenTag entry — the Feishu handoff", () => {
  it("goes straight to Feishu for an existing Agent on reload", async () => {
    api.getAgent.mockResolvedValue(agentRow());
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.textContent).toContain("Feishu Bot for Ada assistant");
    expect(container.textContent).not.toContain("Waiting for your computer to connect");
  });

  it("starts the Bot registration and shows the confirmation QR", async () => {
    api.getAgent.mockResolvedValue(agentRow());
    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    api.getAgentFeishuBinding.mockResolvedValue({
      binding: feishuBinding({ registrationUrl: "https://feishu.example/confirm/abc" }),
    });
    await click(button(container, "Connect Bot"));

    expect(api.startAgentFeishuRegistration).toHaveBeenCalledWith(AGENT_UUID, "Ada assistant · First Tree");
    expect(container.textContent).toContain("Scan with Feishu");
    expect(container.querySelector("svg title")?.textContent).toBe("Feishu Bot registration QR code");
    expect(container.querySelector("a[href='https://feishu.example/confirm/abc']")).not.toBeNull();
  });

  it("only calls the Bot connected once it is actually reachable", async () => {
    api.getAgent.mockResolvedValue(agentRow());
    api.getAgentFeishuBinding.mockResolvedValue({
      binding: feishuBinding({ status: "active", connectionStatus: "connecting", appId: "cli_1" }),
    });

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);
    // Provisioned is not connected: promising a channel that carries no
    // messages yet is the failure mode this guards.
    expect(container.textContent).toContain("connecting to Feishu");
    expect(container.textContent).not.toContain("The Bot is connected.");

    api.getAgentFeishuBinding.mockResolvedValue({
      binding: feishuBinding({ status: "active", connectionStatus: "connected", appId: "cli_1" }),
    });
    const connected = await renderAt(`/opentag?agent=${AGENT_UUID}`);
    expect(connected.textContent).toContain("The Bot is connected.");
  });

  it("states a failing Bot connection in words, not only in colour", async () => {
    api.getAgent.mockResolvedValue(agentRow());
    api.getAgentFeishuBinding.mockResolvedValue({
      binding: feishuBinding({
        status: "active",
        connectionStatus: "error",
        appId: "cli_1",
        lastErrorMessage: "Feishu rejected the Bot credentials.",
      }),
    });

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Feishu rejected the Bot credentials.");
    expect(container.textContent).not.toContain("The Bot is connected.");
  });

  it("does not offer to connect a Bot when the binding read failed", async () => {
    api.getAgent.mockResolvedValue(agentRow());
    api.getAgentFeishuBinding.mockRejectedValue(new ApiError(500, "boom"));

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);
    // "No Bot" is not established, so starting a second registration must not
    // be on offer.
    expect(container.textContent).toContain("couldn't check whether this Agent already has a Bot");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Connect Bot"))).toBe(false);
  });

  it("keeps a failed registration on this step with the server's reason", async () => {
    api.getAgent.mockResolvedValue(agentRow());
    api.startAgentFeishuRegistration.mockRejectedValue(new ApiError(502, "Feishu is unavailable right now"));

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);
    await click(button(container, "Connect Bot"));

    expect(container.textContent).toContain("Feishu is unavailable right now");
    expect(button(container, "Connect Bot").disabled).toBe(false);
  });
});
