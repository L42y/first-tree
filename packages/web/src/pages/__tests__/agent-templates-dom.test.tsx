// @vitest-environment happy-dom

import type { AgentTemplateCatalogOutput } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../test-utils/dom-harness.js";

const templateMocks = vi.hoisted(() => ({
  listAgentTemplates: vi.fn(),
}));

vi.mock("../../api/agent-templates.js", () => templateMocks);

import { AgentTemplatesPage } from "../agent-templates.js";

const CATALOG: AgentTemplateCatalogOutput = {
  items: [
    {
      id: "research-assistant",
      title: "Research assistant",
      summary: "Turn an open question into a sourced brief.",
      outcomes: ["Build a research plan", "Summarize findings"],
      customInstructions: "Research carefully and cite the evidence.",
      status: "active",
      skills: [{ name: "Web research", description: "Search and synthesize primary sources." }],
      mcp: [{ name: "knowledge-base", transport: "http" }],
    },
    {
      id: "release-manager",
      title: "Release manager",
      summary: "Coordinate a reliable software release.",
      outcomes: ["Prepare a release checklist"],
      customInstructions: "Track release risks and owners.",
      status: "active",
      skills: [],
      mcp: [],
    },
  ],
};

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{JSON.stringify({ pathname: location.pathname, state: location.state })}</output>
  );
}

function withProviders(
  ui: ReactElement,
  entry:
    | string
    | {
        pathname: string;
        state: {
          fromNewAgent: boolean;
          selectedTemplateIds: string[];
        };
      },
): ReactElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return (
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/agent-templates" element={ui} />
          <Route path="/team" element={<LocationProbe />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

describe("AgentTemplatesPage", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    vi.clearAllMocks();
    templateMocks.listAgentTemplates.mockResolvedValue(CATALOG);
  });

  afterEach(() => harness.cleanup());

  it("browses in a two-column layout and returns an ordered multi-Template selection to New Agent", async () => {
    harness.render(
      withProviders(<AgentTemplatesPage />, {
        pathname: "/agent-templates",
        state: { fromNewAgent: true, selectedTemplateIds: ["research-assistant"] },
      }),
    );

    await harness.waitFor(() => expect(harness.container.textContent).toContain("Research assistant"));
    expect(harness.container.textContent).toContain("Templates");
    expect(harness.container.textContent).toContain("Custom instructions");
    expect(harness.container.textContent).toContain("Web research");
    expect(harness.container.textContent).toContain("knowledge-base");
    expect(harness.container.querySelector("input")).toBeNull();
    expect(buttonByText(harness.container, "Use this template")).toBeTruthy();

    const addRelease = harness.container.querySelector<HTMLButtonElement>("button[aria-label='Add Release manager']");
    expect(addRelease).not.toBeNull();
    await act(async () => addRelease?.click());
    expect(buttonByText(harness.container, "Use 2 templates")).toBeTruthy();

    await act(async () => buttonByText(harness.container, "Use 2 templates").click());
    await harness.waitFor(() => expect(harness.container.textContent).toContain('"pathname":"/team"'));
    expect(harness.container.textContent).toContain('"templateIds":["research-assistant","release-manager"]');
  });

  it("uses the direct-entry fallback action when no Template is selected", async () => {
    harness.render(withProviders(<AgentTemplatesPage />, "/agent-templates"));

    await harness.waitFor(() => expect(harness.container.textContent).toContain("Release manager"));
    expect(buttonByText(harness.container, "Create an agent without a template")).toBeTruthy();
    expect(harness.container.textContent).not.toContain("Start from scratch");
  });
});
