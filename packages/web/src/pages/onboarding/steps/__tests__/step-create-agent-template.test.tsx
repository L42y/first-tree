// @vitest-environment happy-dom

import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeOnboardingTemplateIntent } from "../../../../utils/onboarding-flags.js";
import { StepCreateAgent } from "../step-create-agent.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const templateMocks = vi.hoisted(() => ({
  listAgentTemplates: vi.fn(),
  getAgentTemplate: vi.fn(),
  updateAgentTemplates: vi.fn(),
}));

const flowMock = vi.hoisted(() => ({
  path: "admin" as const,
  organizationId: "org-1" as string | null,
  agentDisplayName: "My assistant",
  setAgentDisplayName: vi.fn(),
  visibility: "organization" as const,
  setVisibility: vi.fn(),
  computer: {
    connectedClient: { id: "client-1" } as { id: string } | null,
    selectedRuntime: "claude-code" as string | null,
    setSelectedRuntime: vi.fn(),
    okRuntimes: ["claude-code"],
  },
  createAgent: vi.fn(async (_args: Record<string, unknown>) => undefined),
  retryAgent: vi.fn(async () => undefined),
  finishLater: vi.fn(async () => undefined),
  agentPhase: "idle" as const,
  agentError: null as string | null,
  goNext: vi.fn(),
  goTo: vi.fn(),
  sequence: ["create-team", "connect-computer", "create-agent", "start-chat"] as const,
}));

const authMock = vi.hoisted(() => ({
  value: { currentOrgHasPersonalAgent: false },
}));

vi.mock("../../../../api/agent-templates.js", () => templateMocks);
vi.mock("../../onboarding-flow.js", async () => {
  const actual = await vi.importActual<typeof import("../../onboarding-flow.js")>("../../onboarding-flow.js");
  return { ...actual, useOnboardingFlow: () => flowMock };
});
vi.mock("../../../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

const NOW = "2026-07-30T12:00:00.000Z";

const TEMPLATE: AgentTemplatePublicTemplate = {
  id: "0190f000-0000-7000-8000-000000000001",
  slug: "pr-engineer",
  name: "PR Engineer",
  status: "active",
  public: {
    tagline: "Reviews your pull requests",
    purpose: "Purpose text",
    targetUsers: "Indie hackers",
    userValue: "Value text",
    instructionsSummary: "Instructions summary",
    toolsAndSkillsSummary: "Tools summary",
  },
  updatedAt: NOW,
  replacement: null,
};

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderStep(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <StepCreateAgent />
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find((el) => el.textContent?.trim().includes(text));
  if (!button) throw new Error(`Missing button "${text}". Body: ${document.body.textContent ?? ""}`);
  return button;
}

describe("StepCreateAgent template intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    flowMock.agentPhase = "idle";
    flowMock.agentError = null;
    flowMock.organizationId = "org-1";
    flowMock.computer.connectedClient = { id: "client-1" };
    flowMock.computer.selectedRuntime = "claude-code";
    authMock.value.currentOrgHasPersonalAgent = false;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    window.sessionStorage.clear();
  });

  it("shows the intent responsibility selected by default and submits its exact template id", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    templateMocks.getAgentTemplate.mockResolvedValue(TEMPLATE);
    await renderStep();
    await flush();

    expect(templateMocks.getAgentTemplate).toHaveBeenCalledWith("pr-engineer");
    expect(document.body.textContent).toContain("PR Engineer");
    expect(document.body.textContent).toContain("Reviews your pull requests");

    await click(buttonByText("Create agent"));
    expect(flowMock.createAgent).toHaveBeenCalledTimes(1);
    expect(flowMock.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ templateIds: [TEMPLATE.id], organizationId: "org-1" }),
    );
  });

  it("lets the member remove the intent and create from scratch", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    templateMocks.getAgentTemplate.mockResolvedValue(TEMPLATE);
    await renderStep();
    await flush();
    expect(document.body.textContent).toContain("PR Engineer");

    await click(buttonByText("Remove"));
    expect(document.body.textContent).not.toContain("Reviews your pull requests");

    await click(buttonByText("Create agent"));
    expect(flowMock.createAgent).toHaveBeenCalledTimes(1);
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.templateIds).toBeUndefined();
  });

  it("degrades to plain create when the template is retired", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    templateMocks.getAgentTemplate.mockResolvedValue({ ...TEMPLATE, status: "retired" });
    await renderStep();
    await flush();

    expect(document.body.textContent).toContain("no longer available");
    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.templateIds).toBeUndefined();
  });

  it("degrades to plain create when the detail fetch fails", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    templateMocks.getAgentTemplate.mockRejectedValue(new Error("network down"));
    await renderStep();
    await flush();

    expect(document.body.textContent).toContain("no longer available");
    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.templateIds).toBeUndefined();
  });

  it("ignores a stale handoff written for another org", async () => {
    writeOnboardingTemplateIntent("org-2", "pr-engineer");
    await renderStep();
    await flush();

    expect(templateMocks.getAgentTemplate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("PR Engineer");
    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.templateIds).toBeUndefined();
  });

  it("keeps ordinary create byte-identical when there is no intent", async () => {
    await renderStep();
    await flush();

    expect(templateMocks.getAgentTemplate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Remove");
    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.templateIds).toBeUndefined();
  });
});
