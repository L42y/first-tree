// @vitest-environment happy-dom

import type { AgentTemplatePublicTemplate, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateDetailPage } from "../template-detail-page.js";

/**
 * Integration coverage for the Team-confirmation state machine: the REAL
 * React Query client is cleared inside selectOrganization (mirroring
 * auth-context), so the detail query re-pends and refetches mid-flow. The
 * intent subtree — including an open NewAgentDialog — must survive that
 * window, and the dialog may only open against the exact confirmed Team.
 */

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const templateMocks = vi.hoisted(() => ({
  listAgentTemplates: vi.fn(),
  getAgentTemplate: vi.fn(),
  updateAgentTemplates: vi.fn(),
}));

const flagsMocks = vi.hoisted(() => ({
  writeOnboardingTemplateIntent: vi.fn(),
}));

const dialogMock = vi.hoisted(() => ({
  mounts: 0,
  openProps: [] as Array<{ open: boolean; initialTemplateSlug?: string }>,
}));

const analyticsMocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    isAuthenticated: true,
    meLoaded: true,
    meAuthoritative: true,
    onboardingStep: "completed" as "connect" | "create_agent" | "completed" | null,
    currentOrgHasPersonalAgent: true,
    onboardingDismissedAt: null as string | null,
    onboardingCompletedAt: "2026-07-01T00:00:00.000Z" as string | null,
    organizationId: "org-1" as string | null,
    memberships: [] as MeMembership[],
    selectOrganization: vi.fn(async (_orgId: string) => undefined),
  },
}));

vi.mock("../../../api/agent-templates.js", () => templateMocks);
vi.mock("../../../utils/onboarding-flags.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/onboarding-flags.js")>()),
  ...flagsMocks,
}));
vi.mock("../../../components/new-agent-dialog.js", () => ({
  NewAgentDialog: (props: { open: boolean; initialTemplateSlug?: string }) => {
    dialogMock.openProps.push({ open: props.open, initialTemplateSlug: props.initialTemplateSlug });
    return <DialogStub open={props.open} />;
  },
}));
vi.mock("../../../analytics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../analytics.js")>()),
  ...analyticsMocks,
}));
vi.mock("../../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

function DialogStub({ open }: { open: boolean }) {
  useEffect(() => {
    dialogMock.mounts += 1;
  }, []);
  return open ? <div>new-agent-dialog-stub</div> : null;
}

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

function membership(id: string, orgId: string, orgName: string, overrides: Partial<MeMembership> = {}): MeMembership {
  return {
    id,
    organizationId: orgId,
    organizationName: orgName,
    role: "admin",
    agentId: `agent-${orgId}`,
    orgHasOtherMembers: false,
    hasUsableAgent: true,
    hasPersonalAgent: true,
    onboardingSuppressedAt: null,
    onboardingSuppressedReason: null,
    onboardingCompletedAt: NOW,
    ...overrides,
  };
}

let root: Root | null = null;
let testQueryClient: QueryClient | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function pageTree(): ReactNode {
  return (
    <QueryClientProvider client={queryClient()}>
      <MemoryRouter initialEntries={["/templates/pr-engineer?use=1"]}>
        <Routes>
          <Route path="/templates/:slug" element={<TemplateDetailPage />} />
          <Route path="/onboarding" element={<div>onboarding-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function renderPage(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(pageTree());
  });
  await flush();
}

/**
 * Force a full re-render after auth mutations. In production this is exactly
 * what AuthProvider's setSelectedOrgId/fetchMe state writes do after
 * `selectOrganization`; our auth mock is a plain object, so the test drives
 * the same propagation explicitly.
 */
async function rerenderPage(): Promise<void> {
  await act(async () => {
    root?.render(pageTree());
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
  const button = [...document.body.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button "${text}". Body: ${document.body.textContent ?? ""}`);
  return button;
}

function optionCardByText(text: string): HTMLElement {
  const label = [...document.body.querySelectorAll("label")].find((el) => el.textContent?.includes(text));
  if (!label) throw new Error(`Missing option card "${text}". Body: ${document.body.textContent ?? ""}`);
  const input = label.querySelector("input");
  return (input ?? label) as HTMLElement;
}

function queryClient(): QueryClient {
  if (!testQueryClient) throw new Error("page not rendered");
  return testQueryClient;
}

describe("Template intent × real queryClient.clear() integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogMock.mounts = 0;
    dialogMock.openProps.length = 0;
    templateMocks.getAgentTemplate.mockResolvedValue(TEMPLATE);
    authMock.value.isAuthenticated = true;
    authMock.value.meLoaded = true;
    authMock.value.meAuthoritative = true;
    authMock.value.onboardingStep = "completed";
    authMock.value.currentOrgHasPersonalAgent = true;
    authMock.value.onboardingDismissedAt = null;
    authMock.value.onboardingCompletedAt = NOW;
    authMock.value.organizationId = "org-1";
    authMock.value.memberships = [membership("m-1", "org-1", "Acme Team")];
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    testQueryClient = null;
    document.body.innerHTML = "";
  });

  it("keeps the intent subtree mounted through cache clear + refetch and opens the dialog on the confirmed team", async () => {
    authMock.value.selectOrganization = vi.fn(async (orgId: string) => {
      // Mirror auth-context.selectOrganization: wipe every cached query,
      // then settle on the target with a fresh memberships array.
      queryClient().clear();
      authMock.value.organizationId = orgId;
      authMock.value.memberships = [...authMock.value.memberships];
    });
    await renderPage();
    // Detail loaded once; chooser visible.
    expect(document.body.textContent).toContain("Start with PR Engineer");
    const callsBefore = templateMocks.getAgentTemplate.mock.calls.length;

    await click(buttonByText("Continue"));
    await flush();
    // Production: AuthProvider's state writes re-render every useAuth
    // consumer, which also revives the cleared detail query. Simulate the
    // same propagation (the auth mock is a plain object).
    await rerenderPage();
    await flush();

    // The clear + auth-driven re-render forced a real refetch of the detail
    // query…
    expect(templateMocks.getAgentTemplate.mock.calls.length).toBeGreaterThan(callsBefore);
    // …yet the dialog subtree was never unmounted…
    expect(dialogMock.mounts).toBe(1);
    // …and it ended open against the confirmed team with the intent slug.
    expect(document.body.textContent).toContain("new-agent-dialog-stub");
    expect(dialogMock.openProps.filter((p) => p.open).at(-1)?.initialTemplateSlug).toBe("pr-engineer");
  });

  it("surfaces a recoverable error and never opens the dialog when auth reconciles to a fallback", async () => {
    authMock.value.memberships = [membership("m-1", "org-1", "Acme Team"), membership("m-2", "org-2", "Side Team")];
    authMock.value.selectOrganization = vi.fn(async (_orgId: string) => {
      queryClient().clear();
      // Target membership vanished mid-switch: auth settles on the fallback.
      authMock.value.organizationId = "org-1";
      authMock.value.memberships = [membership("m-1", "org-1", "Acme Team")];
    });
    await renderPage();

    await click(optionCardByText("Side Team"));
    await click(buttonByText("Continue"));
    await flush();
    await flush();

    expect(document.body.textContent).toContain("couldn't confirm that team");
    expect(document.body.textContent).not.toContain("new-agent-dialog-stub");
    expect(dialogMock.openProps.every((p) => !p.open)).toBe(true);
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();
  });

  it("writes the handoff for the confirmed team and enters onboarding when that team still needs it", async () => {
    authMock.value.memberships = [
      membership("m-1", "org-1", "Acme Team"),
      membership("m-2", "org-2", "Fresh Team", {
        hasPersonalAgent: false,
        hasUsableAgent: false,
        onboardingCompletedAt: null,
      }),
    ];
    authMock.value.selectOrganization = vi.fn(async (orgId: string) => {
      queryClient().clear();
      authMock.value.organizationId = orgId;
      authMock.value.currentOrgHasPersonalAgent = false;
      authMock.value.onboardingCompletedAt = null;
      authMock.value.memberships = [...authMock.value.memberships];
    });
    await renderPage();

    await click(optionCardByText("Fresh Team"));
    await click(buttonByText("Continue"));
    await flush();
    await flush();

    expect(flagsMocks.writeOnboardingTemplateIntent).toHaveBeenCalledWith("org-2", "pr-engineer");
    expect(document.body.textContent).toContain("onboarding-stub");
    expect(document.body.textContent).not.toContain("new-agent-dialog-stub");
    expect(dialogMock.openProps.every((p) => !p.open)).toBe(true);
  });
});
