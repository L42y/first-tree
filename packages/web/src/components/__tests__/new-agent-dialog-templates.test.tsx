// @vitest-environment happy-dom

import { AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES, type Agent, type AgentTemplatePublicTemplate } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../api/activity.js";
import { ApiError } from "../../api/client.js";
import { NewAgentDialog } from "../new-agent-dialog.js";
import { ToastProvider } from "../ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  getClientCapabilities: vi.fn(),
  listClients: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  checkAgentNameAvailability: vi.fn(),
  createAgent: vi.fn(),
}));

const templateMocks = vi.hoisted(() => ({
  listAgentTemplates: vi.fn(),
  updateAgentTemplates: vi.fn(),
}));

const analyticsMocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1",
    refreshMe: vi.fn(async () => undefined),
  },
}));

vi.mock("../../api/activity.js", () => activityMocks);
vi.mock("../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/agents.js")>()),
  ...agentMocks,
}));
vi.mock("../../api/agent-templates.js", () => templateMocks);
vi.mock("../../analytics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../analytics.js")>()),
  ...analyticsMocks,
}));
vi.mock("../../api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client.js")>();
  return {
    ...actual,
    api: { ...actual.api, post: vi.fn(async () => ({ token: "t", bootstrapCommand: "cmd", expiresIn: 60 })) },
  };
});
vi.mock("../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));
vi.mock("../../lib/visibility-interval.js", () => ({
  runVisibilityAwareInterval: (tick: () => void | Promise<void>) => {
    void tick();
    return () => undefined;
  },
}));

const NOW = "2026-05-28T12:00:00.000Z";

let root: Root | null = null;

function capability() {
  return { state: "ok" as const, available: true, sdkVersion: "1.0.0", detectedAt: NOW };
}

function client(): HubClient {
  return {
    id: "client-1",
    userId: "user-self",
    status: "connected",
    authState: "ok",
    binName: "first-tree-dev",
    sdkVersion: "0.5.0",
    hostname: "gandy-macbook",
    os: "darwin",
    agentCount: 0,
    connectedAt: NOW,
    lastSeenAt: NOW,
    capabilities: { "claude-code": capability() },
  };
}

function template(id: string, name: string, tagline = `Tagline of ${name}`): AgentTemplatePublicTemplate {
  return {
    id,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    status: "active",
    public: {
      tagline,
      purpose: `Purpose of ${name}`,
      targetUsers: `Users of ${name}`,
      userValue: `Value of ${name}`,
      instructionsSummary: "summary",
      toolsAndSkillsSummary: `Tools of ${name}`,
    },
    updatedAt: NOW,
    replacement: null,
  };
}

const TEMPLATE_A = template("0190f000-0000-7000-8000-000000000001", "PR Engineer");
const TEMPLATE_B = template("0190f000-0000-7000-8000-000000000002", "Docs Writer");
const TEMPLATE_C = template("0190f000-0000-7000-8000-000000000003", "Repo Gardener");
const TEMPLATE_D = template("0190f000-0000-7000-8000-000000000004", "Release Captain");

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForText(text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (document.body.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}". Body: ${document.body.textContent ?? ""}`);
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

async function renderDialog(onCreated = vi.fn()): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <NewAgentDialog open onOpenChange={() => undefined} onCreated={onCreated} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
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

function createdAgent(): Agent {
  return {
    uuid: "agent-created-1",
    name: "build-bot",
    displayName: "Build Bot",
    type: "agent",
    managerId: "member-self",
    visibility: "private",
    avatarColorToken: null,
    avatarImageUrl: null,
    status: "active",
    organizationId: "org-1",
    delegateMention: null,
    inboxId: "inbox-1",
    metadata: {},
    source: "portal",
    clientId: "client-1",
    runtimeProvider: "claude-code",
    runtimeState: "idle",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("NewAgentDialog template responsibilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityMocks.listClients.mockResolvedValue([client()]);
    activityMocks.getClientCapabilities.mockResolvedValue({ capabilities: client().capabilities });
    agentMocks.checkAgentNameAvailability.mockResolvedValue({ available: true });
    agentMocks.createAgent.mockResolvedValue(createdAgent());
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  async function fillNameAndOpenPicker(name: string): Promise<void> {
    const input = document.body.querySelector<HTMLInputElement>("#new-agent-display-name");
    if (!input) throw new Error("missing display name input");
    await setValue(input, name);
    await click(buttonByText("Choose a template"));
  }

  it("hides the section when the catalog is empty and keeps plain create unchanged", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [] });
    const onCreated = vi.fn();
    await renderDialog(onCreated);
    await flush();
    expect(document.body.textContent).not.toContain("Responsibilities");

    await fillNameAndOpenPickerSafe();
    async function fillNameAndOpenPickerSafe() {
      const input = document.body.querySelector<HTMLInputElement>("#new-agent-display-name");
      if (!input) throw new Error("missing display name input");
      await setValue(input, "Build Bot");
    }
    await click(buttonByText("Create"));
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toBeUndefined();
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("hides the section when the catalog fails to load", async () => {
    templateMocks.listAgentTemplates.mockRejectedValue(new Error("boom"));
    await renderDialog();
    await flush();
    await waitForCondition(() => templateMocks.listAgentTemplates.mock.calls.length === 1, "catalog not fetched");
    await flush();
    expect(document.body.textContent).not.toContain("Responsibilities");
    const input = document.body.querySelector<HTMLInputElement>("#new-agent-display-name");
    if (!input) throw new Error("missing display name input");
    await setValue(input, "Build Bot");
    await click(buttonByText("Create"));
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toBeUndefined();
  });

  it("submits one selected template and keeps the form draft intact", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A, TEMPLATE_B] });
    await renderDialog();
    await fillNameAndOpenPicker("Build Bot");
    await waitForText("PR Engineer");
    const pickerLabel = [...document.body.querySelectorAll('[data-slot="template-responsibility-label"]')].find((el) =>
      el.textContent?.includes("PR Engineer"),
    );
    expect(pickerLabel?.textContent).toBe(
      "PR EngineerActivePurpose of PR EngineerValue of PR EngineerTools of PR Engineer",
    );
    await click(optionCardByText("PR Engineer"));

    // Draft intact: name, visibility, computer, runtime untouched by selection.
    const nameInput = document.body.querySelector<HTMLInputElement>("#new-agent-display-name");
    expect(nameInput?.value).toBe("Build Bot");
    // Picker and selection use the same compact responsibility label. The
    // catalog-only tagline and audience are not repeated in this Team flow.
    const selectedLabel = [...document.body.querySelectorAll('[data-slot="template-responsibility-label"]')].find(
      (el) => el.textContent?.includes("PR Engineer"),
    );
    expect(selectedLabel?.textContent).toBe(pickerLabel?.textContent);
    expect(document.body.textContent).not.toContain("Tagline of PR Engineer");
    expect(document.body.textContent).not.toContain("Users of PR Engineer");

    await click(buttonByText("Create"));
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toEqual([TEMPLATE_A.id]);
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_select", {
      surface: "new_agent",
      action: "add",
      slug: TEMPLATE_A.slug,
    });
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_create_success", { template_count: 1 });
    // The draft-open event belongs to the caller's navigate path, not the dialog.
    expect(analyticsMocks.trackEvent).not.toHaveBeenCalledWith("agent_create_draft_open", expect.anything());
  });

  it("removes a selected template before submit", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A] });
    await renderDialog();
    await fillNameAndOpenPicker("Build Bot");
    await waitForText("PR Engineer");
    await click(optionCardByText("PR Engineer"));
    await click(buttonByText("Remove"));
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_select", {
      surface: "new_agent",
      action: "remove",
      slug: TEMPLATE_A.slug,
    });
    await click(buttonByText("Create"));
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toBeUndefined();
  });

  it("hides the add affordance when nothing more can be added", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A] });
    await renderDialog();
    await fillNameAndOpenPicker("Build Bot");
    await waitForText("PR Engineer");
    await click(optionCardByText("PR Engineer"));
    expect(document.body.textContent).not.toContain("Add another responsibility");
    // No dead empty picker state either.
    expect(document.body.textContent).not.toContain("Add a responsibility");
  });

  it("keeps the submit-time snapshot through a deferred success", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A] });
    let resolveCreate!: (value: Agent) => void;
    agentMocks.createAgent.mockImplementation(
      () =>
        new Promise<Agent>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const onCreated = vi.fn();
    await renderDialog(onCreated);
    await fillNameAndOpenPicker("Build Bot");
    await waitForText("PR Engineer");
    await click(optionCardByText("PR Engineer"));

    await click(buttonByText("Create"));
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    // The user changes their mind mid-flight — the snapshot must win.
    await click(buttonByText("Remove"));
    await act(async () => {
      resolveCreate(createdAgent());
    });
    await flush();

    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toEqual([TEMPLATE_A.id]);
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_create_success", { template_count: 1 });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ uuid: "agent-created-1" }), "claude-code", 1);
  });

  it("caps selection at three responsibilities", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A, TEMPLATE_B, TEMPLATE_C, TEMPLATE_D] });
    await renderDialog();
    await fillNameAndOpenPicker("Build Bot");
    await waitForText("PR Engineer");
    await click(optionCardByText("PR Engineer"));
    await click(buttonByText("Add another responsibility"));
    await click(optionCardByText("Docs Writer"));
    await click(buttonByText("Add another responsibility"));
    await click(optionCardByText("Repo Gardener"));

    await waitForText("Up to 3 responsibilities per agent.");
    expect(document.body.textContent).not.toContain("Add another responsibility");

    await click(buttonByText("Create"));
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toEqual([TEMPLATE_A.id, TEMPLATE_B.id, TEMPLATE_C.id]);
  });

  it("surfaces a non-CAS adoption 409 on the Responsibilities section, not as a name conflict", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A, TEMPLATE_B] });
    agentMocks.createAgent.mockRejectedValueOnce(
      new ApiError(
        409,
        'A Team Skill named "adopt-skill" already exists',
        undefined,
        AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.ADOPTION_CONFLICT,
      ),
    );
    await renderDialog();
    await fillNameAndOpenPicker("Build Bot");
    await waitForText("PR Engineer");
    await click(optionCardByText("PR Engineer"));
    await click(buttonByText("Create"));
    await waitForText('A Team Skill named "adopt-skill" already exists');
    expect(document.body.textContent).not.toMatch(/already in use/i);

    // Changing the Template selection away from the submit snapshot hides the feedback.
    await click(buttonByText("Remove"));
    await flush();
    expect(document.body.textContent).not.toContain('A Team Skill named "adopt-skill" already exists');
  });

  it("ignores a late adoption 409 after the draft selection changed during pending", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A, TEMPLATE_B] });
    let rejectCreate!: (reason: unknown) => void;
    agentMocks.createAgent.mockImplementation(
      () =>
        new Promise<Agent>((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );
    const onCreated = vi.fn();
    await renderDialog(onCreated);
    await fillNameAndOpenPicker("Build Bot");
    await waitForText("PR Engineer");
    await click(optionCardByText("PR Engineer"));

    await click(buttonByText("Create"));
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    // Pending window: clear the selection (draft is now 0 Templates).
    await click(buttonByText("Remove"));
    expect(document.body.textContent).toContain("Choose a template");

    await act(async () => {
      rejectCreate(
        new ApiError(
          409,
          'A Team Skill named "adopt-skill" already exists',
          undefined,
          AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.ADOPTION_CONFLICT,
        ),
      );
    });
    await flush();

    // Late rejection must not paint onto the changed draft.
    expect(document.body.textContent).not.toContain('A Team Skill named "adopt-skill" already exists');
    expect(document.body.textContent).not.toMatch(/already in use/i);
    expect(document.body.textContent).toContain("Choose a template");
    expect(onCreated).not.toHaveBeenCalled();

    // Next submit uses the current (empty) snapshot.
    agentMocks.createAgent.mockResolvedValueOnce(createdAgent());
    await click(buttonByText("Create"));
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 2, "second create not called");
    const body = agentMocks.createAgent.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toBeUndefined();
  });
});
