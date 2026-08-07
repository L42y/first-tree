// @vitest-environment happy-dom

import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useLayoutEffect } from "react";
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

const flowMock = vi.hoisted(() => {
  function nullable<T>(value: T): T | null {
    return value;
  }

  return {
    path: "admin" as const,
    organizationId: "org-1" as string | null,
    agentDisplayName: "My assistant",
    setAgentDisplayName: vi.fn(),
    visibility: "organization" as const,
    setVisibility: vi.fn(),
    computer: {
      connectedClients: [{ id: "client-1", hostname: "gandy-macbook", os: "darwin" }],
      selectedClientId: nullable("client-1"),
      setSelectedClientId: vi.fn(),
      connectedClient: nullable({ id: "client-1", hostname: "gandy-macbook", os: "darwin" }),
      capabilitiesLoaded: true,
      selectedRuntime: nullable("claude-code"),
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
  };
});

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

const TEMPLATE_B: AgentTemplatePublicTemplate = {
  ...TEMPLATE,
  id: "0190f000-0000-7000-8000-000000000002",
  slug: "docs-writer",
  name: "Docs Writer",
};

let root: Root | null = null;
let stepQueryClient: QueryClient | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function stepTree(): ReactNode {
  return (
    <QueryClientProvider client={stepQueryClient as QueryClient}>
      <StepCreateAgent />
      {windowProbeEnabled ? <WindowProbe /> : null}
    </QueryClientProvider>
  );
}

/**
 * Deterministic commit-to-passive-effect window driver. Its layout effect
 * runs DURING Team B's commit — after StepCreateAgent's own layout effects,
 * before ANY passive effect — exactly the window in which a stale lookup
 * callback must already be invalidated. (Promise callbacks are microtasks
 * and would run after act's passive flush, so the test invokes the captured
 * lookup callback synchronously from here.)
 */
let windowProbeEnabled = false;
let pendingWindowCallback: (() => void) | null = null;

function WindowProbe() {
  useLayoutEffect(() => {
    const cb = pendingWindowCallback;
    pendingWindowCallback = null;
    cb?.();
  });
  return null;
}

/** A thenable whose callbacks are captured for synchronous invocation. */
function deferredLookup(): {
  impl: () => Promise<AgentTemplatePublicTemplate>;
  fireSuccess: (value: AgentTemplatePublicTemplate) => void;
  fireFailure: (reason: unknown) => void;
} {
  let onSuccess: ((value: AgentTemplatePublicTemplate) => void) | null = null;
  let onFailure: ((reason: unknown) => void) | null = null;
  return {
    impl: () =>
      ({
        // biome-ignore lint/suspicious/noThenProperty: intentional minimal thenable — lets the test fire the stale lookup callback synchronously inside the commit window instead of waiting for a microtask.
        then: (cb: (value: AgentTemplatePublicTemplate) => void) => {
          onSuccess = cb;
          return {
            catch: (errCb: (reason: unknown) => void) => {
              onFailure = errCb;
            },
          };
        },
      }) as unknown as Promise<AgentTemplatePublicTemplate>,
    fireSuccess: (value) => onSuccess?.(value),
    fireFailure: (reason) => onFailure?.(reason),
  };
}

async function renderStep(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  stepQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(stepTree());
  });
  await flush();
}

/** Re-render after mutating flow/auth mocks (e.g. a Team switch). */
async function rerenderStep(): Promise<void> {
  await act(async () => {
    root?.render(stepTree());
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
    flowMock.computer.connectedClient = { id: "client-1", hostname: "gandy-macbook", os: "darwin" };
    flowMock.computer.selectedRuntime = "claude-code";
    authMock.value.currentOrgHasPersonalAgent = false;
    windowProbeEnabled = false;
    pendingWindowCallback = null;
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

  it("blocks creation while the explicit intent is still resolving", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    let resolveTemplate!: (value: AgentTemplatePublicTemplate) => void;
    templateMocks.getAgentTemplate.mockImplementation(
      () =>
        new Promise<AgentTemplatePublicTemplate>((resolve) => {
          resolveTemplate = resolve;
        }),
    );
    await renderStep();
    await flush();

    expect(document.body.textContent).toContain("Resolving your template…");
    const createButton = buttonByText("Create agent");
    expect(createButton.disabled).toBe(true);
    // Handler-level guard too: even a synthetic click reaches no create call.
    await click(createButton);
    expect(flowMock.createAgent).not.toHaveBeenCalled();

    // Active resolution unblocks and submits the exact id.
    await act(async () => {
      resolveTemplate(TEMPLATE);
    });
    await flush();
    expect(buttonByText("Create agent").disabled).toBe(false);
    await click(buttonByText("Create agent"));
    expect(flowMock.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ templateIds: [TEMPLATE.id], organizationId: "org-1" }),
    );
  });

  it("unlocks plain create on the explicit pending Remove, and a late resolution is ignored", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    let resolveTemplate!: (value: AgentTemplatePublicTemplate) => void;
    templateMocks.getAgentTemplate.mockImplementation(
      () =>
        new Promise<AgentTemplatePublicTemplate>((resolve) => {
          resolveTemplate = resolve;
        }),
    );
    await renderStep();
    await flush();
    expect(document.body.textContent).toContain("Resolving your template…");

    await click(buttonByText("Create without this template"));
    expect(document.body.textContent).not.toContain("Resolving your template…");
    await click(buttonByText("Create agent"));
    expect(flowMock.createAgent).toHaveBeenCalledTimes(1);
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.templateIds).toBeUndefined();

    // The late lookup must not reapply the card or re-block anything.
    await act(async () => {
      resolveTemplate(TEMPLATE);
    });
    await flush();
    expect(document.body.textContent).not.toContain("Reviews your pull requests");
    expect(document.body.textContent).not.toContain("Resolving your template…");
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

  it("drops the intent entirely when the team changes under a mounted step", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    templateMocks.getAgentTemplate.mockResolvedValue(TEMPLATE);
    await renderStep();
    await flush();
    expect(document.body.textContent).toContain("PR Engineer");

    // Team switch (org-2 has NO handoff): the card and any template id must
    // disappear, and the create goes to org-2 with no templateIds.
    flowMock.organizationId = "org-2";
    await rerenderStep();
    await flush();
    expect(document.body.textContent).not.toContain("PR Engineer");

    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.organizationId).toBe("org-2");
    expect(args.templateIds).toBeUndefined();
  });

  it("loads the new team's own intent after a switch", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    writeOnboardingTemplateIntent("org-2", "docs-writer");
    templateMocks.getAgentTemplate.mockImplementation(async (slug: string) =>
      slug === "pr-engineer" ? TEMPLATE : TEMPLATE_B,
    );
    await renderStep();
    await flush();
    expect(document.body.textContent).toContain("PR Engineer");

    flowMock.organizationId = "org-2";
    await rerenderStep();
    await flush();
    expect(document.body.textContent).toContain("Docs Writer");
    expect(document.body.textContent).not.toContain("PR Engineer");

    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.organizationId).toBe("org-2");
    expect(args.templateIds).toEqual([TEMPLATE_B.id]);
  });

  it("ignores a late fetch for the previous team's slug", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    let resolveA!: (value: AgentTemplatePublicTemplate) => void;
    templateMocks.getAgentTemplate.mockImplementation(
      () =>
        new Promise<AgentTemplatePublicTemplate>((resolve) => {
          resolveA = resolve;
        }),
    );
    await renderStep();
    await flush();

    flowMock.organizationId = "org-2";
    await rerenderStep();
    // The old fetch resolves AFTER the switch — it must not paint org-1's
    // template onto org-2.
    await act(async () => {
      resolveA(TEMPLATE);
    });
    await flush();
    expect(document.body.textContent).not.toContain("PR Engineer");

    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.templateIds).toBeUndefined();
  });

  it("does not carry a removal decision across teams", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    writeOnboardingTemplateIntent("org-2", "docs-writer");
    templateMocks.getAgentTemplate.mockImplementation(async (slug: string) =>
      slug === "pr-engineer" ? TEMPLATE : TEMPLATE_B,
    );
    await renderStep();
    await flush();
    await click(buttonByText("Remove"));
    expect(document.body.textContent).not.toContain("PR Engineer");

    flowMock.organizationId = "org-2";
    await rerenderStep();
    await flush();
    // Team B's intent starts selected again — A's Remove never applied to B.
    expect(document.body.textContent).toContain("Docs Writer");
  });

  it("discards a stale success fired inside the commit-to-passive-effect window after a team switch", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    const lookup = deferredLookup();
    templateMocks.getAgentTemplate.mockImplementation(lookup.impl);
    await renderStep();
    await flush();

    // Fire Team A's lookup callback synchronously from a layout effect inside
    // Team B's commit — after StepCreateAgent's layout effects, before the new
    // passive fetch effect — the exact window the reviewer identified. On the
    // pre-fix code the callback still owns the old sequence and writes Team
    // A's template into Team B; with the commit-time invalidation it is
    // already stale and discarded.
    windowProbeEnabled = true;
    flowMock.organizationId = "org-2";
    pendingWindowCallback = () => lookup.fireSuccess(TEMPLATE);
    act(() => {
      root?.render(stepTree());
    });
    await flush();

    // Team A's template must never paint or submit for Team B.
    expect(document.body.textContent).not.toContain("PR Engineer");
    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.organizationId).toBe("org-2");
    expect(args.templateIds).toBeUndefined();
  });

  it("discards a stale failure fired inside the commit-to-passive-effect window after a team switch", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    const lookup = deferredLookup();
    templateMocks.getAgentTemplate.mockImplementation(lookup.impl);
    await renderStep();
    await flush();

    windowProbeEnabled = true;
    flowMock.organizationId = "org-2";
    pendingWindowCallback = () => lookup.fireFailure(new Error("network down"));
    act(() => {
      root?.render(stepTree());
    });
    await flush();

    // Team A's failure must not paint Team B as unavailable either.
    expect(document.body.textContent).not.toContain("no longer available");
    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.organizationId).toBe("org-2");
    expect(args.templateIds).toBeUndefined();
  });

  it("restarts the lookup for the new team when both teams hand off the same slug", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    writeOnboardingTemplateIntent("org-2", "pr-engineer");
    const TEMPLATE_B_SAME_SLUG: AgentTemplatePublicTemplate = {
      ...TEMPLATE,
      id: "0190f000-0000-7000-8000-000000000009",
      slug: "pr-engineer",
      name: "PR Engineer B",
    };
    templateMocks.getAgentTemplate.mockResolvedValueOnce(TEMPLATE).mockResolvedValueOnce(TEMPLATE_B_SAME_SLUG);
    await renderStep();
    await flush();
    expect(document.body.textContent).toContain("PR Engineer");
    expect(templateMocks.getAgentTemplate).toHaveBeenCalledTimes(1);

    // Same slug on both sides — the string does not change, but Team B still
    // needs its OWN lookup with the committed {org, slug} identity.
    flowMock.organizationId = "org-2";
    await rerenderStep();
    await flush();

    expect(templateMocks.getAgentTemplate).toHaveBeenCalledTimes(2);
    expect(templateMocks.getAgentTemplate).toHaveBeenLastCalledWith("pr-engineer");
    // B's own resolution painted — pending cleared, never A's stale content.
    expect(document.body.textContent).toContain("PR Engineer B");
    expect(document.body.textContent).not.toContain("Resolving your template…");

    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.organizationId).toBe("org-2");
    expect(args.templateIds).toEqual([TEMPLATE_B_SAME_SLUG.id]);
  });

  it("starts the new team's lookup even when the previous team's same-slug request is still pending", async () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    writeOnboardingTemplateIntent("org-2", "pr-engineer");
    let resolveA!: (value: AgentTemplatePublicTemplate) => void;
    const TEMPLATE_B_SAME_SLUG: AgentTemplatePublicTemplate = {
      ...TEMPLATE,
      id: "0190f000-0000-7000-8000-000000000009",
      slug: "pr-engineer",
      name: "PR Engineer B",
    };
    templateMocks.getAgentTemplate
      .mockImplementationOnce(
        () =>
          new Promise<AgentTemplatePublicTemplate>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockResolvedValueOnce(TEMPLATE_B_SAME_SLUG);
    await renderStep();
    await flush();
    expect(document.body.textContent).toContain("Resolving your template…");

    flowMock.organizationId = "org-2";
    await rerenderStep();
    await flush();

    // B's own lookup started and resolved — pending cleared with B's content.
    expect(templateMocks.getAgentTemplate).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("PR Engineer B");

    // Team A's late resolution is ignored.
    await act(async () => {
      resolveA(TEMPLATE);
    });
    await flush();
    expect(document.body.textContent).toContain("PR Engineer B");

    await click(buttonByText("Create agent"));
    const args = flowMock.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.organizationId).toBe("org-2");
    expect(args.templateIds).toEqual([TEMPLATE_B_SAME_SLUG.id]);
  });
});
