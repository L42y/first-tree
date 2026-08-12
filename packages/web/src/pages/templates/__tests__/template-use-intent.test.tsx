// @vitest-environment happy-dom

import type { AgentTemplatePublicTemplate, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";
import type { StoredCampaignActionHandoff } from "../../../utils/onboarding-flags.js";
import { firstTeamAgentName, TemplateUseIntent } from "../template-use-intent.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const flagsMocks = vi.hoisted(() => ({
  writeOnboardingTemplateIntent: vi.fn(),
  readCampaignActionHandoffFlag: vi.fn((): StoredCampaignActionHandoff | null => null),
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
    hasNoTeam: false,
    selectOrganization: vi.fn(async (_orgId: string) => undefined),
    refreshMe: vi.fn(async () => undefined),
  },
}));

const teamAgentsMocks = vi.hoisted(() => ({
  provisionFirstTeamAgent: vi.fn(),
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
vi.mock("../../../api/team-agents.js", () => teamAgentsMocks);
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
    authMock.value.hasNoTeam = false;
    authMock.value.refreshMe = vi.fn(async () => undefined);
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
    // The chooser's primary action shares the AA brand-foreground contract.
    const continueButton = buttonByText("Continue");
    expect(continueButton.className).toContain("bg-brand");
    expect(continueButton.className).toContain("text-brand-foreground");

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

    // Confirming the CURRENT team (the common single-Team route) fails:
    // the chooser must unfreeze with a recoverable error — never stay on
    // "Confirming team…", never open the dialog, never hand off.
    await click(buttonByText("Continue"));
    await rerender();
    expect(document.body.textContent).toContain("couldn't switch to that team");
    expect(document.body.textContent).not.toContain("Confirming team…");
    expect(buttonByText("Continue").disabled).toBe(false);
    expect(dialogOpenCount()).toBe(0);
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();
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
          resolveSwitch = () => {
            // A resolved switch always carries a FRESH /me snapshot (new
            // memberships identity) — the confirmation unlock condition.
            authMock.value.memberships = [...authMock.value.memberships];
            resolve(undefined);
          };
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
          resolveSwitch = () => {
            // A resolved switch always carries a FRESH /me snapshot (new
            // memberships identity) — the confirmation unlock condition.
            authMock.value.memberships = [...authMock.value.memberships];
            resolve(undefined);
          };
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
          resolveSwitch = () => {
            // A resolved switch always carries a FRESH /me snapshot (new
            // memberships identity) — the confirmation unlock condition.
            authMock.value.memberships = [...authMock.value.memberships];
            resolve(undefined);
          };
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

  it("shows a recoverable error and never confirms when the switch rejects after an optimistic window", async () => {
    authMock.value.memberships = [membership("m-1", "org-1", "Acme Team"), membership("m-2", "org-2", "Side Team")];
    let rejectSwitch!: (reason: unknown) => void;
    authMock.value.selectOrganization = vi.fn(
      (_orgId: string) =>
        new Promise<undefined>((_resolve, reject) => {
          rejectSwitch = reject;
        }),
    );
    await renderIntent();

    await click(optionCardByText("Side Team"));
    await click(buttonByText("Continue"));

    // Optimistic window: auth already displays the unconfirmed target (the
    // real selectOrganization writes it before /me answers). Nothing may
    // confirm from this alone — the optimistic org is not authority.
    authMock.value.organizationId = "org-2";
    await rerender();
    expect(dialogOpenCount()).toBe(0);
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirming team…");

    // The post-switch /me fails: selectOrganization rejects (its rollback is
    // covered by the AuthProvider tests) and the auth value settles back on
    // the pre-switch Team. The chooser recovers with an error, unfrozen.
    authMock.value.organizationId = "org-1";
    await act(async () => {
      rejectSwitch(new Error("network"));
    });
    await rerender();

    expect(document.body.textContent).toContain("couldn't switch to that team");
    expect(document.body.textContent).toContain("Continue");
    expect(dialogOpenCount()).toBe(0);
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();

    // Retry path: a fresh confirm against the same target works.
    authMock.value.selectOrganization = vi.fn(async (orgId: string) => {
      authMock.value.organizationId = orgId;
      authMock.value.memberships = [...authMock.value.memberships];
      return undefined;
    });
    // Re-render so the rendered handlers close over the new mock.
    await rerender();
    await click(optionCardByText("Side Team"));
    await click(buttonByText("Continue"));
    await rerender();
    expect(dialogOpenCount()).toBeGreaterThan(0);
  });
});

describe("TemplateUseIntent — Team-less caller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogMock.props.length = 0;
    authMock.value.meLoaded = true;
    // The state a solo sign-in now leaves behind: authenticated, no Team.
    authMock.value.hasNoTeam = true;
    authMock.value.organizationId = null;
    authMock.value.memberships = [];
    authMock.value.onboardingStep = "connect";
    authMock.value.currentOrgHasPersonalAgent = false;
    authMock.value.onboardingCompletedAt = null;
    authMock.value.onboardingDismissedAt = null;
    authMock.value.refreshMe = vi.fn(async () => undefined);
    authMock.value.selectOrganization = vi.fn(async (orgId: string) => {
      authMock.value.organizationId = orgId;
      authMock.value.hasNoTeam = false;
    });
    teamAgentsMocks.provisionFirstTeamAgent.mockResolvedValue({
      organizationId: "org-new",
      memberId: "member-new",
      teamCreated: true,
      agentCreated: true,
      agent: {
        uuid: "agent-new",
        name: "pr-engineer",
        displayName: "PR Engineer",
        visibility: "organization",
        clientId: null,
      },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container = null;
    document.body.innerHTML = "";
  });

  it("offers a single confirm instead of an empty Team chooser", async () => {
    await renderIntent();

    expect(document.body.textContent).toContain("Create Team Agent");
    // No Team to pick between, and no per-org onboarding handoff to write —
    // there is no org to key one to.
    expect(document.body.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(flagsMocks.writeOnboardingTemplateIntent).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("onboarding-stub");
  });

  it("provisions the Team and Agent together, then activates the new Team", async () => {
    await renderIntent();
    await click(buttonByText("Create Team Agent"));

    expect(teamAgentsMocks.provisionFirstTeamAgent).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      name: "pr-engineer",
      displayName: "PR Engineer",
      templateIds: [TEMPLATE.id],
    });
    // The destination is org-scoped, so the just-created Team is activated
    // before navigating away from this public page.
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-new");
    expect(navigateMock).toHaveBeenCalledWith("/?c=draft&with=agent-new");
  });

  it("resumes the stored campaign action through onboarding after first-Agent provisioning", async () => {
    flagsMocks.readCampaignActionHandoffFlag.mockReturnValueOnce({
      campaign: "production-scan",
      repoUrl: "https://github.com/acme/backend",
      reportKey: null,
      repoSlug: "acme/backend",
    });
    await renderIntent();
    await click(buttonByText("Create Team Agent"));

    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-new");
    expect(navigateMock).toHaveBeenCalledWith("/onboarding");
    expect(navigateMock).not.toHaveBeenCalledWith("/?c=draft&with=agent-new");
  });

  it("surfaces a recoverable error and re-reads /me when provisioning fails", async () => {
    teamAgentsMocks.provisionFirstTeamAgent.mockRejectedValueOnce(new Error("boom"));
    await renderIntent();
    await click(buttonByText("Create Team Agent"));

    expect(document.body.textContent).toContain("Nothing was created");
    expect(authMock.value.refreshMe).toHaveBeenCalled();
    expect(authMock.value.selectOrganization).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();

    // Retry works from the same screen.
    await click(buttonByText("Create Team Agent"));
    expect(teamAgentsMocks.provisionFirstTeamAgent).toHaveBeenCalledTimes(2);
    expect(teamAgentsMocks.provisionFirstTeamAgent.mock.calls[0]?.[0].requestId).toBe(
      teamAgentsMocks.provisionFirstTeamAgent.mock.calls[1]?.[0].requestId,
    );
    expect(navigateMock).toHaveBeenCalledWith("/?c=draft&with=agent-new");
  });

  it("reconciles a different-request conflict into the existing-Team Template path", async () => {
    teamAgentsMocks.provisionFirstTeamAgent.mockRejectedValueOnce(new ApiError(409, "A different request won"));
    authMock.value.refreshMe = vi.fn(async () => {
      authMock.value.hasNoTeam = false;
      authMock.value.memberships = [membership("m-winner", "org-winner", "Winner Team")];
      authMock.value.organizationId = "org-winner";
      authMock.value.onboardingStep = "completed";
      authMock.value.currentOrgHasPersonalAgent = true;
      authMock.value.onboardingCompletedAt = NOW;
    });

    await renderIntent();
    await click(buttonByText("Create Team Agent"));
    await rerender();

    expect(authMock.value.refreshMe).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Nothing was created");
    expect(document.body.textContent).not.toContain("Create Team Agent");
    expect(document.body.textContent).toContain("Winner Team");
    const winner = document.body.querySelector<HTMLInputElement>('input[type="radio"]');
    expect(winner).not.toBeNull();
    expect(winner?.checked).toBe(true);
    expect(buttonByText("Continue").disabled).toBe(false);
  });

  it("does not claim nothing was created when only activating the new Team failed", async () => {
    authMock.value.selectOrganization = vi.fn(async () => {
      throw new Error("post-switch /me failed");
    });
    // The provision succeeded, so a real /me re-read now reports the Team the
    // server created — the caller is no longer Team-less.
    authMock.value.refreshMe = vi.fn(async () => {
      authMock.value.hasNoTeam = false;
      authMock.value.memberships = [membership("m-new", "org-new", "New Team")];
      authMock.value.organizationId = "org-new";
    });
    await renderIntent();
    await click(buttonByText("Create Team Agent"));
    await rerender();

    // The Agent exists. Telling the user otherwise would send them off to
    // create a second one.
    expect(teamAgentsMocks.provisionFirstTeamAgent).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("was created");
    expect(document.body.textContent).not.toContain("Nothing was created");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("ignores a second click while the first provision is in flight", async () => {
    let release = (): void => undefined;
    teamAgentsMocks.provisionFirstTeamAgent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              organizationId: "org-new",
              memberId: "member-new",
              teamCreated: true,
              agentCreated: true,
              agent: {
                uuid: "agent-new",
                name: "pr-engineer",
                displayName: "PR Engineer",
                visibility: "organization",
                clientId: null,
              },
            });
        }),
    );
    await renderIntent();
    await click(buttonByText("Create Team Agent"));
    // The button flipped to its in-flight label and a second click is a no-op.
    await click(buttonByText("Creating…"));

    expect(teamAgentsMocks.provisionFirstTeamAgent).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
    await flush();
    expect(navigateMock).toHaveBeenCalledWith("/?c=draft&with=agent-new");
  });
});

describe("firstTeamAgentName", () => {
  it("uses the Template slug and yields to the server for reserved names", () => {
    expect(firstTeamAgentName("pr-engineer")).toBe("pr-engineer");
    expect(firstTeamAgentName("agent")).toBeUndefined();
    expect(firstTeamAgentName("a".repeat(80))).toHaveLength(64);
  });
});
