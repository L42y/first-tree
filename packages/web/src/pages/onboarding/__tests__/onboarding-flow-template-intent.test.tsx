// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnboardingTemplateIntent, writeOnboardingTemplateIntent } from "../../../utils/onboarding-flags.js";
import { OnboardingFlowProvider } from "../onboarding-flow.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const creationMock = vi.hoisted(() => ({
  options: null as null | {
    onCreated?: (info: { agentUuid: string; args: Record<string, unknown> }) => void | Promise<void>;
    onOnline?: (uuid: string) => void;
    onFailure?: (failure: unknown) => void;
  },
}));

const analyticsMocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  reportOnboardingEvent: vi.fn(async () => undefined),
}));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-2" as string | null,
    memberId: "member-1",
    role: "admin",
    user: { username: "devuser" },
    teamDisplayName: "Side Team",
    orgHasOtherMembers: false,
    onboardingStep: "create_agent" as const,
    currentOrgHasPersonalAgent: false,
    currentOrgHasUsableAgent: false,
    refreshMe: vi.fn(async () => undefined),
    dismissOnboarding: vi.fn(async () => undefined),
    applyOnboardingKickoffStamp: vi.fn(),
  },
}));

vi.mock("../../../features/agent-setup/use-agent-creation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../features/agent-setup/use-agent-creation.js")>();
  return {
    ...actual,
    useAgentCreation: (options: Record<string, unknown>) => {
      creationMock.options = options as typeof creationMock.options;
      return { phase: "idle", error: null, create: vi.fn(), retry: vi.fn(), createdUuid: null };
    },
  };
});
vi.mock("../../../features/agent-setup/use-computer-connection.js", () => ({
  useComputerConnection: () => ({
    connectedClients: [],
    selectedClientId: null,
    setSelectedClientId: vi.fn(),
    connectedClient: null,
    capabilitiesLoaded: false,
    okRuntimes: [],
  }),
}));
vi.mock("../../../api/onboarding-events.js", () => eventMocks);
vi.mock("../../../analytics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../analytics.js")>()),
  ...analyticsMocks,
}));
vi.mock("../../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderFlow(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OnboardingFlowProvider path="admin">
            <div>flow-child</div>
          </OnboardingFlowProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

describe("OnboardingFlowProvider template intent cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    creationMock.options = null;
    authMock.value.organizationId = "org-2";
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    window.sessionStorage.clear();
  });

  it("clears the handoff for the org the agent was actually submitted to, not the drifted selection", async () => {
    // The create POST went to org-1; the member has since switched to org-2.
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    writeOnboardingTemplateIntent("org-2", "docs-writer");
    await renderFlow();

    const onCreated = creationMock.options?.onCreated;
    if (!onCreated) throw new Error("useAgentCreation options not captured");
    await act(async () => {
      await onCreated({
        agentUuid: "agent-1",
        args: {
          displayName: "Bot",
          clientId: "client-1",
          runtimeProvider: "claude-code",
          visibility: "organization",
          organizationId: "org-1",
          templateIds: ["0190f000-0000-7000-8000-000000000001"],
        },
      });
    });
    await flush();

    // org-1 (the real submit target) is cleared; org-2 (the drifted
    // selection) keeps its own handoff untouched.
    expect(readOnboardingTemplateIntent("org-1")).toBeNull();
    expect(readOnboardingTemplateIntent("org-2")).toBe("docs-writer");
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_create_success", { template_count: 1 });
    // The server-side event is attributed to the submit target, not the
    // drifted current org.
    expect(eventMocks.reportOnboardingEvent).toHaveBeenCalledWith(
      "agent_created",
      expect.objectContaining({ organizationId: "org-1" }),
    );
  });

  it("clears nothing when the submit-time org is missing (fail closed)", async () => {
    writeOnboardingTemplateIntent("org-2", "docs-writer");
    await renderFlow();

    const onCreated = creationMock.options?.onCreated;
    if (!onCreated) throw new Error("useAgentCreation options not captured");
    await act(async () => {
      await onCreated({
        agentUuid: "agent-1",
        args: {
          displayName: "Bot",
          clientId: "client-1",
          runtimeProvider: "claude-code",
          visibility: "organization",
          organizationId: null,
        },
      });
    });
    await flush();

    // No submit-time org → no handoff is cleared anywhere (the drifting
    // closure must not be used as a guess), and the event carries null org.
    expect(readOnboardingTemplateIntent("org-2")).toBe("docs-writer");
    expect(eventMocks.reportOnboardingEvent).toHaveBeenCalledWith(
      "agent_created",
      expect.objectContaining({ organizationId: null }),
    );
  });

  it("fires no template success event for a plain creation", async () => {
    await renderFlow();
    const onCreated = creationMock.options?.onCreated;
    if (!onCreated) throw new Error("useAgentCreation options not captured");
    await act(async () => {
      await onCreated({
        agentUuid: "agent-1",
        args: {
          displayName: "Bot",
          clientId: "client-1",
          runtimeProvider: "claude-code",
          visibility: "organization",
          organizationId: "org-2",
        },
      });
    });
    await flush();
    expect(analyticsMocks.trackEvent).not.toHaveBeenCalledWith("agent_template_create_success", expect.anything());
  });
});
