// @vitest-environment happy-dom

import type { AgentTemplatePublicTemplate, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateDetailPage } from "../template-detail-page.js";

/**
 * Same-Route slug transitions: React Router reuses the TemplateDetailPage
 * instance across `/templates/:slug` param changes, so the sticky intent
 * snapshot and per-slug analytics must be keyed by slug identity — never by
 * mount. TemplateUseIntent is stubbed so these tests observe exactly which
 * Template the page hands to intent resolution.
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

const analyticsMocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));

const intentStubCalls = vi.hoisted(() => ({
  slugs: [] as string[],
}));

vi.mock("../../../api/agent-templates.js", () => templateMocks);
vi.mock("../../../utils/onboarding-flags.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/onboarding-flags.js")>()),
  ...flagsMocks,
}));
vi.mock("../../../analytics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../analytics.js")>()),
  ...analyticsMocks,
}));
vi.mock("../../../components/new-agent-dialog.js", () => ({
  NewAgentDialog: () => null,
}));
vi.mock("../template-use-intent.js", () => ({
  TemplateUseIntent: ({ template }: { template: AgentTemplatePublicTemplate }) => {
    intentStubCalls.slugs.push(template.slug);
    return <div>{`intent-stub:${template.slug}`}</div>;
  },
}));
vi.mock("../../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

const authMock = vi.hoisted(() => ({
  value: {
    isAuthenticated: true,
    meLoaded: true,
    onboardingStep: "completed" as const,
    currentOrgHasPersonalAgent: true,
    onboardingDismissedAt: null as string | null,
    onboardingCompletedAt: "2026-07-01T00:00:00.000Z" as string | null,
    organizationId: "org-1" as string | null,
    memberships: [] as MeMembership[],
    selectOrganization: vi.fn(async () => undefined),
  },
}));

const NOW = "2026-07-30T12:00:00.000Z";

function template(id: string, slug: string, name: string): AgentTemplatePublicTemplate {
  return {
    id,
    slug,
    name,
    status: "active",
    public: {
      tagline: `Tagline of ${name}`,
      purpose: `Purpose of ${name}`,
      targetUsers: `Users of ${name}`,
      userValue: `Value of ${name}`,
      instructionsSummary: `Instructions of ${name}`,
      toolsAndSkillsSummary: `Tools of ${name}`,
    },
    updatedAt: NOW,
    replacement: null,
  };
}

const TEMPLATE_A = template("0190f000-0000-7000-8000-000000000001", "pr-engineer", "PR Engineer");
const TEMPLATE_B = template("0190f000-0000-7000-8000-000000000002", "docs-writer", "Docs Writer");

let root: Root | null = null;
const navRef: { current: ((to: string) => void) | null } = { current: null };

function NavProbe() {
  const navigate = useNavigate();
  navRef.current = (to: string) => navigate(to);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderApp(entry: string): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <NavProbe />
          <Routes>
            <Route path="/templates/:slug" element={<TemplateDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function navigateTo(to: string): Promise<void> {
  if (!navRef.current) throw new Error("nav probe not mounted");
  await act(async () => {
    navRef.current?.(to);
  });
  await flush();
}

function detailViewEvents(): Array<Record<string, unknown>> {
  return analyticsMocks.trackEvent.mock.calls
    .filter(([name]) => name === "agent_template_detail_view")
    .map(([, params]) => params as Record<string, unknown>);
}

describe("TemplateDetailPage slug transitions (same Route instance)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intentStubCalls.slugs.length = 0;
    templateMocks.getAgentTemplate.mockImplementation(async (slug: string) =>
      slug === "pr-engineer" ? TEMPLATE_A : TEMPLATE_B,
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    navRef.current = null;
    document.body.innerHTML = "";
  });

  it("never shows the previous template's intent while the next slug's detail is pending", async () => {
    await renderApp("/templates/pr-engineer?use=1");
    await flush();
    // Intent resolution for A is live (sticky captured).
    expect(document.body.textContent).toContain("intent-stub:pr-engineer");

    // Navigate A → B on the SAME Route instance, with B's detail deferred.
    let resolveB!: (value: AgentTemplatePublicTemplate) => void;
    templateMocks.getAgentTemplate.mockImplementation(
      () =>
        new Promise<AgentTemplatePublicTemplate>((resolve) => {
          resolveB = resolve;
        }),
    );
    await navigateTo("/templates/docs-writer?use=1");
    await flush();

    // The pending window must not render A's intent at all.
    expect(document.body.textContent).not.toContain("intent-stub:pr-engineer");
    expect(document.body.textContent).not.toContain("PR Engineer");
    expect(intentStubCalls.slugs.filter((slug) => slug === "docs-writer")).toHaveLength(0);
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();

    // Once B resolves, only B's intent is used.
    await act(async () => {
      resolveB(TEMPLATE_B);
    });
    await flush();
    expect(document.body.textContent).toContain("intent-stub:docs-writer");
    expect(document.body.textContent).not.toContain("intent-stub:pr-engineer");
  });

  it("dedupes the detail view event by slug transition, not by mount", async () => {
    await renderApp("/templates/pr-engineer");
    await flush();
    expect(detailViewEvents()).toEqual([{ slug: "pr-engineer", status: "active", authenticated: true }]);

    // A → B: B earns its own event on the same component instance.
    await navigateTo("/templates/docs-writer");
    await flush();
    expect(detailViewEvents()).toEqual([
      { slug: "pr-engineer", status: "active", authenticated: true },
      { slug: "docs-writer", status: "active", authenticated: true },
    ]);

    // B → A: a fresh transition back fires again.
    await navigateTo("/templates/pr-engineer");
    await flush();
    expect(detailViewEvents()).toHaveLength(3);
    expect(detailViewEvents().at(-1)).toEqual({ slug: "pr-engineer", status: "active", authenticated: true });
  });
});
