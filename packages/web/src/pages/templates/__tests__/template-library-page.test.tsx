// @vitest-environment happy-dom

import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateLibraryPage } from "../template-library-page.js";

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
  value: { isAuthenticated: false },
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/templates"]}>
          <TemplateLibraryPage />
        </MemoryRouter>
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
  const button = [...document.body.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button "${text}". Body: ${document.body.textContent ?? ""}`);
  return button;
}

describe("TemplateLibraryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.value.isAuthenticated = false;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("renders active templates from the public-safe catalog without auth", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A, TEMPLATE_B] });
    await renderPage();

    expect(templateMocks.listAgentTemplates).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Agent templates");
    expect(document.body.textContent).toContain("PR Engineer");
    expect(document.body.textContent).toContain("Tagline of PR Engineer");
    expect(document.body.textContent).toContain("For Users of PR Engineer");
    expect(document.body.textContent).toContain("Docs Writer");
    // Cards link to the public detail route.
    const links = [...document.body.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/templates/pr-engineer");
    expect(links).toContain("/templates/docs-writer");
    // Deduped library view with safe properties only.
    const viewCalls = analyticsMocks.trackEvent.mock.calls.filter(([name]) => name === "agent_template_library_view");
    expect(viewCalls).toHaveLength(1);
    expect(viewCalls[0]?.[1]).toEqual({ template_count: 2, authenticated: false });
  });

  it("shows the empty state when no templates are available", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [] });
    await renderPage();
    expect(document.body.textContent).toContain("No templates are available yet.");
  });

  it("shows a recoverable error and retries", async () => {
    templateMocks.listAgentTemplates.mockRejectedValueOnce(new Error("boom"));
    await renderPage();
    expect(document.body.textContent).toContain("couldn't load the template library");

    templateMocks.listAgentTemplates.mockResolvedValueOnce({ templates: [TEMPLATE_A] });
    await click(buttonByText("Try again"));
    expect(templateMocks.listAgentTemplates).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("PR Engineer");
  });

  it("reports the authenticated flag for signed-in visitors", async () => {
    authMock.value.isAuthenticated = true;
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A] });
    await renderPage();
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_library_view", {
      template_count: 1,
      authenticated: true,
    });
  });
});
