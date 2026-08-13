// @vitest-environment happy-dom

import type { Agent, FeishuBotBinding } from "@first-tree/shared";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
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
const refreshMeStrict = vi.hoisted(() => vi.fn(async () => undefined));
const markOnboardingCompleted = vi.hoisted(() => vi.fn(async () => undefined));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: null as string | null,
    meAuthoritative: true,
    currentOrgHasPersonalAgent: false,
    memberId: null as string | null,
    role: null as string | null,
    user: { username: "ada" },
    logout: () => undefined,
    refreshMe,
    refreshMeStrict,
    markOnboardingCompleted,
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

const meChats = vi.hoisted(() => ({ listMeChats: vi.fn() }));
vi.mock("../../../api/me-chats.js", () => meChats);

const chats = vi.hoisted(() => ({ getChat: vi.fn() }));
vi.mock("../../../api/chats.js", () => chats);

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

/** A Bot that is provisioned and actually carrying messages. */
function connectedBinding(overrides: Partial<FeishuBotBinding> = {}): FeishuBotBinding {
  return feishuBinding({ status: "active", connectionStatus: "connected", appId: "cli_1", ...overrides });
}

const NO_CHATS = { priorityRows: { pinned: [] }, rows: [], nextCursor: null };

function chatPage(chatIds: string[]) {
  return { priorityRows: { pinned: [] }, rows: chatIds.map((chatId) => ({ chatId })), nextCursor: null };
}

function feishuTaskChat(botBindingId: string) {
  return { metadata: { source: "feishu", botBindingId, externalChatId: "oc_1", externalChatType: "p2p" } };
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

let lastQueryClient: QueryClient | null = null;

async function renderAt(route: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  lastQueryClient = queryClient;
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
    currentOrgHasPersonalAgent: false,
    memberId: MEMBER,
    role: "admin",
    user: { username: "ada" },
    logout: () => undefined,
    refreshMe,
    refreshMeStrict,
    markOnboardingCompleted,
  };
  refreshMe.mockClear();
  refreshMeStrict.mockReset().mockResolvedValue(undefined);
  markOnboardingCompleted.mockReset().mockResolvedValue(undefined);
  // No Feishu Task by default: the member has connected a Bot at most.
  meChats.listMeChats.mockReset().mockResolvedValue(NO_CHATS);
  chats.getChat.mockReset();
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
    expect(refreshMeStrict).toHaveBeenCalled();
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
  });

  it("puts the created Agent in the URL before waiting on readiness, and heals it there", async () => {
    // The URL is this route's only durable recovery state. Holding the Agent in
    // component state would lose it on reload and let a bare entry offer to
    // create a second one.
    computerMock.value = readyComputer();
    api.createAgent.mockResolvedValue(agentRow());
    api.getAgent.mockResolvedValue(agentRow());
    refreshMeStrict.mockRejectedValue(new Error("me is down"));

    const container = await renderAt("/opentag");
    await click(button(container, "Review Agent"));
    await click(button(container, "Continue"));
    await click(button(container, "Create Agent"));

    expect(api.createAgent).toHaveBeenCalledTimes(1);
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
    // Readiness failed, so it says so and offers a retry — but nothing here can
    // create another Agent, because the URL is Agent-scoped.
    expect(container.textContent).toContain("couldn't refresh your team");
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((label) => label.includes("Create Agent"))).toBe(false);
    expect(labels.some((label) => label.includes("Choose a different teammate"))).toBe(false);

    refreshMeStrict.mockResolvedValue(undefined);
    await click(button(container, "Try again"));
    expect(api.createAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps the created Agent across a reload while /me is still failing", async () => {
    // The reload case the URL-only model exists for: the Agent must still be
    // the subject, and creation must not be on offer again.
    api.getAgent.mockResolvedValue(agentRow());
    refreshMeStrict.mockRejectedValue(new Error("me is down"));

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.textContent).toContain("couldn't refresh your team");
    // The handoff itself stays closed: connecting a Bot here would let the
    // member finish while `/` still believes they have no Agent.
    expect(container.textContent).not.toContain("Feishu Bot for Ada assistant");
    expect(api.getAgentFeishuBinding).not.toHaveBeenCalled();
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((label) => label.includes("Create Agent"))).toBe(false);
    expect(labels.some((label) => label.includes("Review Agent"))).toBe(false);
    expect(api.createAgent).not.toHaveBeenCalled();

    // Once readiness is current, the handoff opens.
    refreshMeStrict.mockResolvedValue(undefined);
    authMock.value = { ...authMock.value, currentOrgHasPersonalAgent: true };
    const ready = await renderAt(`/opentag?agent=${AGENT_UUID}`);
    expect(ready.textContent).toContain("Feishu Bot for Ada assistant");
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
    api.getAgent.mockResolvedValue(agentRow());

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

    await click(button(container, "Continue with Ada assistant"));
    // The recovered Agent goes into the URL, and readiness is healed from
    // there — a fast visit to `/` must not bounce the member into
    // `/onboarding` for an Agent they already have.
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
    // The Agent read has to land before readiness healing can start.
    await flush();
    expect(refreshMeStrict).toHaveBeenCalled();
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
    // The URL is anchored on the new Agent straight away — the `agents`
    // invalidation kicked off here must never stand between the create and the
    // only durable record of what was created.
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
    expect(container.textContent).not.toContain("Review Agent");

    // The handoff itself opens on the next read, once readiness is current.
    authMock.value = { ...authMock.value, currentOrgHasPersonalAgent: true };
    expect((await renderAt(`/opentag?agent=${AGENT_UUID}`)).textContent).toContain("Feishu Bot for Ada assistant");
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
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
  });

  it("anchors the Agent in the URL even while the agents list is still refetching", async () => {
    // The failure this guards: `onSuccess` awaiting the invalidation before
    // navigating. A slow refetch then leaves the browser at the bare entry with
    // the Agent already created — reload there and it is orphaned.
    computerMock.value = readyComputer();
    api.createAgent.mockResolvedValue(agentRow());
    api.getAgent.mockResolvedValue(agentRow());

    const container = await atComputerStep();
    // An active `agents` observer that never settles its refetch. Only an
    // active query makes `invalidateQueries` wait, which is the whole point.
    const client = lastQueryClient;
    if (!client) throw new Error("no QueryClient");
    let calls = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["agents"],
      queryFn: () => (calls++ === 0 ? Promise.resolve([]) : new Promise(() => {})),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await flush();

    await click(button(container, "Create Agent"));

    expect(api.createAgent).toHaveBeenCalledTimes(1);
    expect(client.isFetching({ queryKey: ["agents"] })).toBe(1);
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
    unsubscribe();
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
  beforeEach(() => {
    // The handoff only opens once membership readiness is authoritative.
    authMock.value = { ...authMock.value, currentOrgHasPersonalAgent: true };
  });

  it("lets an admin with no Agent of their own continue a teammate's Agent", async () => {
    // `hasPersonalAgent` counts only Agents this member manages, so for an
    // admin on a teammate's Agent it stays false however often `/me` is read.
    // Gating the handoff on it here would park them on the checking state
    // forever — a dead end, not a wait.
    authMock.value = { ...authMock.value, role: "admin", currentOrgHasPersonalAgent: false };
    api.getAgent.mockResolvedValue({ ...agentRow(), managerId: "member-2" });

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(container.textContent).toContain("Feishu Bot for Ada assistant");
    expect(container.textContent).not.toContain("Finishing up");
    expect(refreshMeStrict).not.toHaveBeenCalled();
  });

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

describe("OpenTag entry — real first use in Feishu", () => {
  beforeEach(() => {
    authMock.value = { ...authMock.value, currentOrgHasPersonalAgent: true };
    api.getAgent.mockResolvedValue(agentRow());
  });

  it("does not ask about first use before a Bot exists", async () => {
    // A Bot the member has not confirmed yet cannot have carried a message, so
    // there is nothing to poll for.
    api.getAgentFeishuBinding.mockResolvedValue({ binding: null });
    await renderAt(`/opentag?agent=${AGENT_UUID}`);
    expect(meChats.listMeChats).not.toHaveBeenCalled();

    api.getAgentFeishuBinding.mockResolvedValue({ binding: feishuBinding({ registrationUrl: "https://f.test/c" }) });
    await renderAt(`/opentag?agent=${AGENT_UUID}`);
    expect(meChats.listMeChats).not.toHaveBeenCalled();
  });

  it("leaves onboarding unfinished while a connected Bot has no task yet", async () => {
    api.getAgentFeishuBinding.mockResolvedValue({ binding: connectedBinding() });

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    // A connected Bot is not first use. The member is still on the step they
    // have something to do about.
    expect(container.textContent).toContain("The Bot is connected.");
    expect(container.textContent).not.toContain("has its first task from Feishu");
    expect(markOnboardingCompleted).not.toHaveBeenCalled();
  });

  it("completes onboarding and hands off once this Agent's task exists", async () => {
    api.getAgentFeishuBinding.mockResolvedValue({ binding: connectedBinding() });
    meChats.listMeChats.mockResolvedValue(chatPage(["chat-1"]));
    chats.getChat.mockResolvedValue(feishuTaskChat("binding-1"));

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(markOnboardingCompleted).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Ada assistant has its first task from Feishu");
    // The handoff destination is the task itself, in the workspace.
    expect(container.querySelector("a[href='/?c=chat-1']")).not.toBeNull();
    // The Bot step is over — offering to connect one here would be a second
    // registration for an Agent that is already working.
    expect(container.textContent).not.toContain("Connect Bot");
  });

  it("cannot be completed by a Feishu task belonging to another Agent", async () => {
    // The chat matches on origin and on this Agent being a speaker — an
    // internal collaborator in a teammate's task looks exactly like this. Only
    // the Bot binding tells them apart, and it is someone else's.
    api.getAgentFeishuBinding.mockResolvedValue({ binding: connectedBinding() });
    meChats.listMeChats.mockResolvedValue(chatPage(["chat-neighbour"]));
    chats.getChat.mockResolvedValue(feishuTaskChat("binding-2"));

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(markOnboardingCompleted).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("has its first task from Feishu");
    expect(container.textContent).toContain("The Bot is connected.");
  });

  it("does not complete onboarding when the task read fails", async () => {
    api.getAgentFeishuBinding.mockResolvedValue({ binding: connectedBinding() });
    meChats.listMeChats.mockRejectedValue(new ApiError(500, "boom"));

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    // "We could not check" is not "not used yet", and it is certainly not
    // "used" — the member stays where they were, and the poll retries.
    expect(markOnboardingCompleted).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The Bot is connected.");
    expect(container.textContent).not.toContain("has its first task from Feishu");
  });

  it("converges on a reload after first use without creating anything a second time", async () => {
    api.getAgentFeishuBinding.mockResolvedValue({ binding: connectedBinding() });
    meChats.listMeChats.mockResolvedValue(chatPage(["chat-1"]));
    chats.getChat.mockResolvedValue(feishuTaskChat("binding-1"));

    await renderAt(`/opentag?agent=${AGENT_UUID}`);
    expect(markOnboardingCompleted).toHaveBeenCalledTimes(1);

    // Same URL, nothing carried over: the terminal state is re-derived from the
    // same authoritative reads rather than from anything this page remembered.
    const reloaded = await renderAt(`/opentag?agent=${AGENT_UUID}`);

    expect(reloaded.textContent).toContain("Ada assistant has its first task from Feishu");
    expect(reloaded.querySelector("a[href='/?c=chat-1']")).not.toBeNull();
    // Nothing about the Agent is re-created, and the URL still names the one
    // Agent this flow made.
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.startAgentFeishuRegistration).not.toHaveBeenCalled();
    expect(lastLocation).toBe(`/opentag?agent=${AGENT_UUID}`);
  });

  it("holds the handoff open and retryable when the completion stamp fails", async () => {
    api.getAgentFeishuBinding.mockResolvedValue({ binding: connectedBinding() });
    meChats.listMeChats.mockResolvedValue(chatPage(["chat-1"]));
    chats.getChat.mockResolvedValue(feishuTaskChat("binding-1"));
    markOnboardingCompleted.mockRejectedValue(new ApiError(500, "boom"));

    const container = await renderAt(`/opentag?agent=${AGENT_UUID}`);
    // The stamp only starts once the task read has landed, so it settles a
    // round later than the step it is rendered in.
    await flush();

    // The task is real, so it is stated as fact — but the destination waits,
    // because an unstamped membership can be sent straight back into setup.
    expect(container.textContent).toContain("Ada assistant has its first task from Feishu");
    expect(container.querySelector("a[href='/?c=chat-1']")).toBeNull();
    expect(container.querySelector("[role='alert']")?.textContent).toContain("couldn't finish setting up");
    // A failure holds until the member acts, rather than being re-fired by the
    // first-use poll behind it.
    expect(markOnboardingCompleted).toHaveBeenCalledTimes(1);

    markOnboardingCompleted.mockResolvedValue(undefined);
    await click(button(container, "Try again"));

    expect(markOnboardingCompleted).toHaveBeenCalledTimes(2);
    expect(container.querySelector("a[href='/?c=chat-1']")).not.toBeNull();
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});
