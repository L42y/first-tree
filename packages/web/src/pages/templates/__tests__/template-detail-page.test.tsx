// @vitest-environment happy-dom

import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";
import { TemplateDetailPage } from "../template-detail-page.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const templateMocks = vi.hoisted(() => ({
  listAgentTemplates: vi.fn(),
  getAgentTemplate: vi.fn(),
  updateAgentTemplates: vi.fn(),
}));

const analyticsMocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    isAuthenticated: false,
    meLoaded: false,
    meAuthoritative: false,
    refreshMe: vi.fn(async () => undefined),
    memberships: [] as unknown[],
  },
}));

const navigateMock = vi.hoisted(() => vi.fn());

const intentMock = vi.hoisted(() => ({
  calls: [] as Array<{ slug: string }>,
}));

vi.mock("../../../api/agent-templates.js", () => templateMocks);
vi.mock("../../../analytics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../analytics.js")>()),
  ...analyticsMocks,
}));
vi.mock("../../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});
vi.mock("../template-use-intent.js", () => ({
  TemplateUseIntent: ({ template }: { template: AgentTemplatePublicTemplate }) => {
    intentMock.calls.push({ slug: template.slug });
    return <div>intent-resolution-stub</div>;
  },
}));

const NOW = "2026-07-30T12:00:00.000Z";

function template(overrides: Partial<AgentTemplatePublicTemplate> = {}): AgentTemplatePublicTemplate {
  return {
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
    ...overrides,
  };
}

let root: Root | null = null;
let loginStateProbe: { pathname: string; search: string } | null = null;

function LoginProbe() {
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string; search: string } } | null)?.from ?? null;
  loginStateProbe = from;
  return <div>login-stub</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let pageQueryClient: QueryClient | null = null;

function pageTree(entry: string) {
  return (
    <QueryClientProvider client={pageQueryClient as QueryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/templates/:slug" element={<TemplateDetailPage />} />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function renderPage(entry: string): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  pageQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(pageTree(entry));
  });
  await flush();
}

async function rerenderPage(entry: string): Promise<void> {
  await act(async () => {
    root?.render(pageTree(entry));
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

describe("TemplateDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intentMock.calls.length = 0;
    loginStateProbe = null;
    authMock.value.isAuthenticated = false;
    authMock.value.meLoaded = false;
    authMock.value.meAuthoritative = false;
    authMock.value.refreshMe = vi.fn(async () => undefined);
    authMock.value.memberships = [];
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("renders the public-safe detail for an active template", async () => {
    templateMocks.getAgentTemplate.mockResolvedValue(template());
    await renderPage("/templates/pr-engineer");

    expect(templateMocks.getAgentTemplate).toHaveBeenCalledWith("pr-engineer");
    expect(document.body.textContent).toContain("PR Engineer");
    expect(document.body.textContent).toContain("Reviews your pull requests");
    expect(document.body.textContent).toContain("Purpose text");
    expect(document.body.textContent).toContain("Indie hackers");
    expect(document.body.textContent).toContain("Value text");
    expect(document.body.textContent).toContain("Tools summary");
    const viewCalls = analyticsMocks.trackEvent.mock.calls.filter(([name]) => name === "agent_template_detail_view");
    expect(viewCalls).toHaveLength(1);
    expect(viewCalls[0]?.[1]).toEqual({ slug: "pr-engineer", status: "active", authenticated: false });
    // The primary CTA uses the shared brand variant with the AA on-brand
    // foreground (near-white on brand green fails WCAG AA).
    const cta = buttonByText("Use this template");
    expect(cta.className).toContain("bg-brand");
    expect(cta.className).toContain("text-brand-foreground");
    expect(cta.className).not.toContain("--fg-on-vivid");
  });

  it("starts the use intent from the CTA with safe analytics", async () => {
    templateMocks.getAgentTemplate.mockResolvedValue(template());
    await renderPage("/templates/pr-engineer");
    await click(buttonByText("Use this template"));

    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_use_started", {
      slug: "pr-engineer",
      authenticated: false,
      team_count: 0,
    });
    expect(navigateMock).toHaveBeenCalledWith("/templates/pr-engineer?use=1");
  });

  it("explains a retired template and links its replacement", async () => {
    templateMocks.getAgentTemplate.mockResolvedValue(
      template({ status: "retired", replacement: { slug: "pr-engineer-v2", name: "PR Engineer v2" } }),
    );
    await renderPage("/templates/pr-engineer");

    expect(document.body.textContent).toContain("has been retired");
    expect(document.body.textContent).not.toContain("Use this template");
    const links = [...document.body.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/templates/pr-engineer-v2");
  });

  it("renders a neutral not-found for a 404 and for an invalid slug", async () => {
    templateMocks.getAgentTemplate.mockRejectedValue(new ApiError(404, "not found"));
    await renderPage("/templates/ghost");
    expect(document.body.textContent).toContain("couldn't find that template");
    expect([...document.body.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain("/templates");

    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();
    await renderPage("/templates/Not_A_Slug");
    expect(templateMocks.getAgentTemplate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("couldn't find that template");
  });

  it("offers retry on a network error", async () => {
    templateMocks.getAgentTemplate.mockRejectedValueOnce(new ApiError(500, "boom"));
    await renderPage("/templates/pr-engineer");
    expect(document.body.textContent).toContain("couldn't load this template");

    templateMocks.getAgentTemplate.mockResolvedValueOnce(template());
    await click(buttonByText("Try again"));
    expect(templateMocks.getAgentTemplate).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("PR Engineer");
  });

  it("bounces a logged-out intent visitor to /login with the exact intent URL preserved", async () => {
    templateMocks.getAgentTemplate.mockResolvedValue(template());
    await renderPage("/templates/pr-engineer?use=1");

    expect(document.body.textContent).toContain("login-stub");
    expect(loginStateProbe).toMatchObject({ pathname: "/templates/pr-engineer", search: "?use=1" });
  });

  it("treats non-canonical intent spellings as ordinary detail, with no login bounce", async () => {
    for (const entry of [
      "/templates/pr-engineer?use=1&campaign=x",
      "/templates/pr-engineer?use=1&use=1",
      "/templates/pr-engineer?use=1#details",
      "/templates/pr-engineer?use=1&",
    ]) {
      act(() => root?.unmount());
      root = null;
      document.body.innerHTML = "";
      vi.clearAllMocks();
      loginStateProbe = null;
      templateMocks.getAgentTemplate.mockResolvedValue(template());
      await renderPage(entry);

      // Logged-out, but NOT bounced to /login: the shared strict parser
      // rejected the URL as an intent, so this is just the public detail.
      expect(document.body.textContent).not.toContain("login-stub");
      expect(loginStateProbe).toBeNull();
      expect(document.body.textContent).toContain("PR Engineer");
    }
  });

  it("hands a signed-in active intent to the intent resolution", async () => {
    authMock.value.isAuthenticated = true;
    authMock.value.meLoaded = true;
    authMock.value.meAuthoritative = true;
    templateMocks.getAgentTemplate.mockResolvedValue(template());
    await renderPage("/templates/pr-engineer?use=1");

    expect(intentMock.calls).toEqual([{ slug: "pr-engineer" }]);
    expect(document.body.textContent).toContain("intent-resolution-stub");
  });

  it("never resolves an intent for a retired template", async () => {
    authMock.value.isAuthenticated = true;
    authMock.value.meLoaded = true;
    authMock.value.meAuthoritative = true;
    templateMocks.getAgentTemplate.mockResolvedValue(template({ status: "retired" }));
    await renderPage("/templates/pr-engineer?use=1");

    expect(intentMock.calls).toHaveLength(0);
    expect(document.body.textContent).toContain("has been retired");
  });

  it("shows a recoverable error with guarded retry when signed-in intent lacks /me authority", async () => {
    authMock.value.isAuthenticated = true;
    authMock.value.meLoaded = true;
    authMock.value.meAuthoritative = false;
    templateMocks.getAgentTemplate.mockResolvedValue(template());
    let resolveRetry!: () => void;
    authMock.value.refreshMe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    await renderPage("/templates/pr-engineer?use=1");

    // No resolution surface may mount without authoritative memberships:
    // no chooser, no dialog, no handoff.
    expect(document.body.textContent).toContain("couldn't confirm your team");
    expect(document.body.textContent).not.toContain("intent-resolution-stub");
    expect(intentMock.calls).toHaveLength(0);

    // Retry is guarded against double-fire while in flight.
    await click(buttonByText("Try again"));
    expect(authMock.value.refreshMe).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Retrying…");
    await click(buttonByText("Retrying…"));
    expect(authMock.value.refreshMe).toHaveBeenCalledTimes(1);

    // A successful fresh /me flips authority and proceeds into resolution.
    authMock.value.meAuthoritative = true;
    await act(async () => {
      resolveRetry();
    });
    await rerenderPage("/templates/pr-engineer?use=1");
    expect(intentMock.calls).toEqual([{ slug: "pr-engineer" }]);
    expect(document.body.textContent).toContain("intent-resolution-stub");
  });
});
