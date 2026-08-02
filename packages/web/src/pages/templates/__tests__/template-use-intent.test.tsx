// @vitest-environment happy-dom

import type { AgentTemplatePublicTemplate, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateUseIntent } from "../template-use-intent.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const flagsMocks = vi.hoisted(() => ({
  writeOnboardingTemplateIntent: vi.fn(),
}));

const dialogMock = vi.hoisted(() => ({
  props: [] as Array<{ open: boolean; initialTemplateSlug?: string }>,
  latestOnCreated: null as null | ((agent: { uuid: string }, runtime: string, templateCount: number) => void),
}));

const navigateMock = vi.hoisted(() => vi.fn());

const analyticsMocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    meLoaded: true,
    onboardingStep: "completed" as "connect" | "create_agent" | "completed" | null,
    currentOrgHasPersonalAgent: true,
    onboardingDismissedAt: null as string | null,
    onboardingCompletedAt: "2026-07-01T00:00:00.000Z" as string | null,
    organizationId: "org-1" as string | null,
    memberships: [] as MeMembership[],
    selectOrganization: vi.fn(async (_orgId: string) => undefined),
  },
}));

vi.mock("../../../utils/onboarding-flags.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/onboarding-flags.js")>()),
  ...flagsMocks,
}));
vi.mock("../../../components/new-agent-dialog.js", () => ({
  NewAgentDialog: (props: {
    open: boolean;
    initialTemplateSlug?: string;
    onCreated: (agent: { uuid: string }, runtime: string, templateCount: number) => void;
  }) => {
    dialogMock.props.push({ open: props.open, initialTemplateSlug: props.initialTemplateSlug });
    dialogMock.latestOnCreated = props.onCreated;
    return props.open ? <div>new-agent-dialog-stub</div> : null;
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
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

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
let container: HTMLElement | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function tree(): ReactNode {
  return (
    <MemoryRouter initialEntries={["/templates/pr-engineer?use=1"]}>
      <Routes>
        <Route path="/templates/:slug" element={<TemplateUseIntent template={TEMPLATE} />} />
        <Route path="/onboarding" element={<div>onboarding-stub</div>} />
      </Routes>
    </MemoryRouter>
  );
}

async function renderIntent(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}>{tree()}</QueryClientProvider>);
  });
  await flush();
}

async function rerender(): Promise<void> {
  await act(async () => {
    root?.render(<QueryClientProvider client={new QueryClient()}>{tree()}</QueryClientProvider>);
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

function radioCheckedForCard(text: string): boolean {
  const label = [...document.body.querySelectorAll("label")].find((el) => el.textContent?.includes(text));
  if (!label) throw new Error(`Missing option card "${text}". Body: ${document.body.textContent ?? ""}`);
  const input = label.querySelector<HTMLInputElement>('input[type="radio"]');
  if (!input) throw new Error(`Missing radio in card "${text}"`);
  return input.checked;
}

function dialogOpenCount(): number {
  return dialogMock.props.filter((p) => p.open).length;
}

describe("TemplateUseIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogMock.props.length = 0;
    dialogMock.latestOnCreated = null;
    authMock.value.meLoaded = true;
    authMock.value.onboardingStep = "completed";
    authMock.value.currentOrgHasPersonalAgent = true;
    authMock.value.onboardingDismissedAt = null;
    authMock.value.onboardingCompletedAt = NOW;
    authMock.value.organizationId = "org-1";
    authMock.value.memberships = [membership("m-1", "org-1", "Acme Team")];
    // Default: the switch lands on the exact target with a fresh memberships
    // array (the real post-switch /me) — matching selectOrganization's
    // client-side semantics.
    authMock.value.selectOrganization = vi.fn(async (orgId: string) => {
      authMock.value.organizationId = orgId;
      authMock.value.memberships = [...authMock.value.memberships];
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container = null;
    document.body.innerHTML = "";
  });

  it("hands a fresh-onboarding member a per-org handoff and enters /onboarding", async () => {
    authMock.value.onboardingStep = "connect";
    authMock.value.currentOrgHasPersonalAgent = false;
    authMock.value.onboardingCompletedAt = null;
    await renderIntent();

    expect(flagsMocks.writeOnboardingTemplateIntent).toHaveBeenCalledWith("org-1", "pr-engineer");
    expect(document.body.textContent).toContain("onboarding-stub");
    // The chooser / dialog path never ran.
    expect(authMock.value.selectOrganization).not.toHaveBeenCalled();
    expect(dialogOpenCount()).toBe(0);
  });

  it("shows an explicit chooser even for a single team, then opens the dialog against the confirmed org", async () => {
    await renderIntent();

    expect(document.body.textContent).toContain("Start with PR Engineer");
    expect(document.body.textContent).toContain("Acme Team");
    expect(document.body.textContent).toContain("Current team");
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();

    await click(buttonByText("Continue"));
    await rerender();
    expect(authMock.value.selectOrganization).toHaveBeenCalledTimes(1);
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-1");
    expect(dialogOpenCount()).toBeGreaterThan(0);
    expect(dialogMock.props.filter((p) => p.open).at(-1)?.initialTemplateSlug).toBe("pr-engineer");
  });

  it("lets a multi-team member pick the exact target team", async () => {
    authMock.value.memberships = [membership("m-1", "org-1", "Acme Team"), membership("m-2", "org-2", "Side Team")];
    await renderIntent();

    await click(optionCardByText("Side Team"));
    await click(buttonByText("Continue"));
    await rerender();
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-2");
    expect(dialogOpenCount()).toBeGreaterThan(0);
  });

  it("never opens the dialog when the team switch rejects", async () => {
    authMock.value.selectOrganization = vi.fn(async () => {
      throw new Error("switch failed");
    });
    await renderIntent();

    await click(buttonByText("Continue"));
    await rerender();
    expect(document.body.textContent).toContain("couldn't switch to that team");
    expect(dialogOpenCount()).toBe(0);
  });

  it("never opens the dialog when auth reconciles to a fallback team", async () => {
    authMock.value.memberships = [membership("m-1", "org-1", "Acme Team"), membership("m-2", "org-2", "Side Team")];
    // The target membership vanished mid-switch: selectOrganization resolves,
    // but auth settles back on the ORIGINAL org with a fresh memberships
    // array that no longer contains the target.
    authMock.value.selectOrganization = vi.fn(async (_orgId: string) => {
      authMock.value.organizationId = "org-1";
      authMock.value.memberships = [membership("m-1", "org-1", "Acme Team")];
    });
    await renderIntent();

    await click(optionCardByText("Side Team"));
    await click(buttonByText("Continue"));
    await rerender();
    expect(document.body.textContent).toContain("couldn't confirm that team");
    expect(dialogOpenCount()).toBe(0);
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();
  });

  it("hands off to onboarding when the confirmed team still needs it", async () => {
    authMock.value.memberships = [
      membership("m-1", "org-1", "Acme Team"),
      membership("m-2", "org-2", "Fresh Team", {
        hasPersonalAgent: false,
        hasUsableAgent: false,
        onboardingCompletedAt: null,
      }),
    ];
    authMock.value.selectOrganization = vi.fn(async (orgId: string) => {
      authMock.value.organizationId = orgId;
      authMock.value.currentOrgHasPersonalAgent = false;
      authMock.value.onboardingCompletedAt = null;
      authMock.value.memberships = [...authMock.value.memberships];
    });
    await renderIntent();

    await click(optionCardByText("Fresh Team"));
    await click(buttonByText("Continue"));
    await rerender();
    // Handoff written for the CONFIRMED team (never Team A's gate reused).
    expect(flagsMocks.writeOnboardingTemplateIntent).toHaveBeenCalledWith("org-2", "pr-engineer");
    expect(document.body.textContent).toContain("onboarding-stub");
    expect(dialogOpenCount()).toBe(0);
  });

  it("navigates to the first workspace draft after creation", async () => {
    await renderIntent();
    await click(buttonByText("Continue"));
    await rerender();
    const onCreated = dialogMock.latestOnCreated;
    if (!onCreated) throw new Error("dialog onCreated not captured");
    await act(async () => {
      onCreated({ uuid: "agent-new-1" }, "claude-code", 1);
    });
    await flush();

    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_create_draft_open", { template_count: 1 });
    expect(navigateMock).toHaveBeenCalledWith("/?c=draft&with=agent-new-1");
  });

  it("ignores a double-click while the switch is in flight", async () => {
    let resolveSwitch!: () => void;
    authMock.value.selectOrganization = vi.fn(
      (_orgId: string) =>
        new Promise<undefined>((resolve) => {
          resolveSwitch = () => resolve(undefined);
        }),
    );
    await renderIntent();

    const button = buttonByText("Continue");
    await click(button);
    // In-flight: the button reads Confirming and is disabled; a second
    // dispatch must not start a concurrent switch.
    expect(document.body.textContent).toContain("Confirming team…");
    await click(buttonByText("Confirming team…"));
    expect(authMock.value.selectOrganization).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSwitch();
    });
    await rerender();
    expect(dialogOpenCount()).toBeGreaterThan(0);
  });

  it("suppresses the generic handoff while auth shows the unconfirmed target mid-flight", async () => {
    authMock.value.memberships = [membership("m-1", "org-1", "Acme Team"), membership("m-2", "org-2", "Side Team")];
    let resolveSwitch!: () => void;
    authMock.value.selectOrganization = vi.fn(
      (_orgId: string) =>
        new Promise<undefined>((resolve) => {
          resolveSwitch = () => resolve(undefined);
        }),
    );
    await renderIntent();

    await click(optionCardByText("Side Team"));
    await click(buttonByText("Continue"));
    expect(authMock.value.selectOrganization).toHaveBeenCalledTimes(1);

    // Mid-flight, auth ALREADY shows org-2 with needs-onboarding facts (the
    // real selectOrganization writes the selected org before /me confirms).
    // The generic gate must not hand off or navigate for this unconfirmed Team.
    authMock.value.organizationId = "org-2";
    authMock.value.currentOrgHasPersonalAgent = false;
    authMock.value.onboardingCompletedAt = null;
    await rerender();
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("onboarding-stub");
    expect(document.body.textContent).toContain("Confirming team…");
    expect(dialogOpenCount()).toBe(0);

    // The promise resolves with auth on the exact target: only NOW the gate
    // is evaluated for org-2 and the handoff is written explicitly.
    await act(async () => {
      resolveSwitch();
    });
    await rerender();
    expect(flagsMocks.writeOnboardingTemplateIntent).toHaveBeenCalledTimes(1);
    expect(flagsMocks.writeOnboardingTemplateIntent).toHaveBeenCalledWith("org-2", "pr-engineer");
    expect(document.body.textContent).toContain("onboarding-stub");
    expect(dialogOpenCount()).toBe(0);
  });

  it("never hands off to a fallback Team that needs onboarding after a failed confirmation", async () => {
    authMock.value.memberships = [
      membership("m-1", "org-1", "Acme Team"),
      membership("m-2", "org-2", "Side Team"),
      membership("m-3", "org-3", "Fresh Team", {
        hasPersonalAgent: false,
        hasUsableAgent: false,
        onboardingCompletedAt: null,
      }),
    ];
    let resolveSwitch!: () => void;
    authMock.value.selectOrganization = vi.fn(
      (_orgId: string) =>
        new Promise<undefined>((resolve) => {
          resolveSwitch = () => resolve(undefined);
        }),
    );
    await renderIntent();

    await click(optionCardByText("Side Team"));
    await click(buttonByText("Continue"));

    // /me comes back: the org-2 membership vanished and auth reconciled to
    // org-3, which happens to need onboarding. The user never confirmed it.
    authMock.value.organizationId = "org-3";
    authMock.value.currentOrgHasPersonalAgent = false;
    authMock.value.onboardingCompletedAt = null;
    authMock.value.memberships = [
      membership("m-1", "org-1", "Acme Team"),
      membership("m-3", "org-3", "Fresh Team", {
        hasPersonalAgent: false,
        hasUsableAgent: false,
        onboardingCompletedAt: null,
      }),
    ];
    await act(async () => {
      resolveSwitch();
    });
    await rerender();

    expect(document.body.textContent).toContain("couldn't confirm that team");
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("onboarding-stub");
    expect(dialogOpenCount()).toBe(0);
  });

  it("freezes the team chooser for the whole switch flight", async () => {
    authMock.value.memberships = [
      membership("m-1", "org-1", "Acme Team"),
      membership("m-2", "org-2", "Side Team"),
      membership("m-3", "org-3", "Third Team"),
    ];
    let resolveSwitch!: () => void;
    authMock.value.selectOrganization = vi.fn(
      (orgId: string) =>
        new Promise<undefined>((resolve) => {
          resolveSwitch = () => {
            // The exact target lands in auth before the promise resolves.
            authMock.value.organizationId = orgId;
            authMock.value.memberships = [...authMock.value.memberships];
            resolve(undefined);
          };
        }),
    );
    await renderIntent();

    // Pick B and confirm.
    await click(optionCardByText("Side Team"));
    expect(radioCheckedForCard("Side Team")).toBe(true);
    await click(buttonByText("Continue"));
    expect(authMock.value.selectOrganization).toHaveBeenCalledTimes(1);
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-2");

    // Mid-flight: clicking C must NOT move the visible selection — the card
    // radios are disabled and the select handler is frozen.
    expect(document.body.textContent).toContain("Confirming team…");
    await click(optionCardByText("Third Team"));
    expect(radioCheckedForCard("Third Team")).toBe(false);
    expect(radioCheckedForCard("Side Team")).toBe(true);
    expect(authMock.value.selectOrganization).toHaveBeenCalledTimes(1);

    // Exact B settles: the flow continues against B — the Team the user
    // last saw selected — never against the mid-flight click target.
    await act(async () => {
      resolveSwitch();
    });
    await rerender();
    expect(dialogOpenCount()).toBeGreaterThan(0);
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();
  });
});
