// @vitest-environment happy-dom

import type { Agent, AgentTemplatePublicTemplate } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../api/activity.js";
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
  getAgentTemplate: vi.fn(),
  updateAgentTemplates: vi.fn(),
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
  trackEvent: vi.fn(),
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

const NOW = "2026-07-30T12:00:00.000Z";

let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient | null = null;

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
    hostname: "dev-macbook",
    os: "darwin",
    agentCount: 0,
    connectedAt: NOW,
    lastSeenAt: NOW,
    capabilities: { "claude-code": capability() },
  };
}

function template(id: string, name: string): AgentTemplatePublicTemplate {
  return {
    id,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    status: "active",
    public: {
      tagline: `Tagline of ${name}`,
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

function Harness({ initialTemplateSlug }: { initialTemplateSlug?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(false)}>
        harness-close
      </button>
      <button type="button" onClick={() => setOpen(true)}>
        harness-open
      </button>
      <NewAgentDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={() => undefined}
        initialTemplateSlug={initialTemplateSlug}
      />
    </>
  );
}

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

async function renderHarness(initialTemplateSlug?: string): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient = client;
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <Harness initialTemplateSlug={initialTemplateSlug} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function rerenderHarness(initialTemplateSlug?: string): Promise<void> {
  if (!queryClient) throw new Error("renderHarness must run first");
  const client = queryClient;
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <Harness initialTemplateSlug={initialTemplateSlug} />
        </ToastProvider>
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

async function fillNameAndSubmit(name: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>("#new-agent-display-name");
  if (!input) throw new Error("missing display name input");
  await setValue(input, name);
  await click(buttonByText("Create"));
}

describe("NewAgentDialog initial Template", () => {
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
    container = null;
    queryClient = null;
    document.body.innerHTML = "";
  });

  it("preselects the intent template once the async catalog resolves", async () => {
    let resolveCatalog!: (value: { templates: AgentTemplatePublicTemplate[] }) => void;
    templateMocks.listAgentTemplates.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    await renderHarness("pr-engineer");
    // Catalog still pending — nothing preselected yet, no crash.
    expect(document.body.textContent).not.toContain("Tagline of PR Engineer");

    await act(async () => {
      resolveCatalog({ templates: [TEMPLATE_A, TEMPLATE_B] });
    });
    await waitForText("Tagline of PR Engineer");

    await fillNameAndSubmit("Build Bot");
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toEqual([TEMPLATE_A.id]);
  });

  it("blocks submission while the explicit intent is still resolving", async () => {
    let resolveCatalog!: (value: { templates: AgentTemplatePublicTemplate[] }) => void;
    templateMocks.listAgentTemplates.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    await renderHarness("pr-engineer");
    await waitForText("Resolving your template…");

    // Everything else is ready, yet Create stays disabled while the explicit
    // intent is unresolved — a hung lookup must not become a plain Agent.
    const input = document.body.querySelector<HTMLInputElement>("#new-agent-display-name");
    if (!input) throw new Error("missing display name input");
    await setValue(input, "Build Bot");
    const createButton = buttonByText("Create");
    expect(createButton.disabled).toBe(true);

    // The handler itself is guarded too: a programmatic form submit (Enter /
    // requestSubmit-style) must not reach the Agent API either.
    const form = document.body.querySelector("form");
    if (!form) throw new Error("missing form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(agentMocks.createAgent).not.toHaveBeenCalled();

    // Resolution unblocks the normal path.
    await act(async () => {
      resolveCatalog({ templates: [TEMPLATE_A, TEMPLATE_B] });
    });
    await waitForText("Tagline of PR Engineer");
    expect(buttonByText("Create").disabled).toBe(false);
  });

  it("unlocks plain create on the explicit pending Remove, and a late response never reapplies", async () => {
    let resolveCatalog!: (value: { templates: AgentTemplatePublicTemplate[] }) => void;
    templateMocks.listAgentTemplates.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    await renderHarness("pr-engineer");
    await waitForText("Resolving your template…");

    await click(buttonByText("Create without it"));
    expect(document.body.textContent).not.toContain("Resolving your template…");
    await fillNameAndSubmit("Build Bot");
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toBeUndefined();

    // The late catalog response must not reapply or re-block the removed intent.
    await act(async () => {
      resolveCatalog({ templates: [TEMPLATE_A, TEMPLATE_B] });
    });
    await flush();
    await flush();
    expect(document.body.textContent).not.toContain("Tagline of PR Engineer");
    expect(document.body.textContent).not.toContain("Resolving your template…");
  });

  it("treats a failed catalog lookup as definitively unavailable and allows plain create", async () => {
    templateMocks.listAgentTemplates.mockRejectedValue(new Error("network down"));
    await renderHarness("pr-engineer");
    await waitForText("no longer available");
    expect(document.body.textContent).not.toContain("Resolving your template…");

    await fillNameAndSubmit("Build Bot");
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toBeUndefined();
  });

  it("never re-applies the intent after the user removes it", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A, TEMPLATE_B] });
    await renderHarness("pr-engineer");
    await waitForText("Tagline of PR Engineer");

    await click(buttonByText("Remove"));
    expect(document.body.textContent).toContain("Choose a template");
    // More effect passes (clients poll etc.) must not resurrect the preselect.
    await flush();
    await flush();
    expect(document.body.textContent).toContain("Choose a template");
    expect(document.body.textContent).not.toContain("Tagline of PR Engineer");
  });

  it("degrades safely when the intent slug is no longer an active template", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_B] });
    await renderHarness("pr-engineer");
    await waitForText("no longer available");

    await fillNameAndSubmit("Build Bot");
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    // No stale id is submitted.
    expect(body.templateIds).toBeUndefined();
  });

  it("does not leak the previous intent into a later ordinary open", async () => {
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [TEMPLATE_A, TEMPLATE_B] });
    await renderHarness("pr-engineer");
    await waitForText("Tagline of PR Engineer");

    // Close, drop the intent prop, reopen — an ordinary open starts clean.
    await click(buttonByText("harness-close"));
    await rerenderHarness(undefined);
    await click(buttonByText("harness-open"));
    await flush();
    await waitForCondition(
      () => templateMocks.listAgentTemplates.mock.calls.length >= 2,
      "catalog not refetched on reopen",
    );
    await flush();
    expect(document.body.textContent).toContain("Choose a template");
    expect(document.body.textContent).not.toContain("Tagline of PR Engineer");
  });

  it("never preselects from the previous open's catalog when the template retired between opens", async () => {
    // First open: the slug is active and preselected.
    templateMocks.listAgentTemplates.mockResolvedValueOnce({ templates: [TEMPLATE_A, TEMPLATE_B] });
    await renderHarness("pr-engineer");
    await waitForText("Tagline of PR Engineer");

    // Close, then reopen with the SAME intent slug — but the Template has
    // since retired, so the fresh catalog no longer carries it.
    templateMocks.listAgentTemplates.mockResolvedValueOnce({ templates: [TEMPLATE_B] });
    await click(buttonByText("harness-close"));
    await click(buttonByText("harness-open"));
    await waitForText("no longer available");
    expect(document.body.textContent).not.toContain("Tagline of PR Engineer");

    // Submission must not contain the stale id.
    await fillNameAndSubmit("Build Bot");
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length === 1, "create not called");
    const body = agentMocks.createAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.templateIds).toBeUndefined();
  });

  it("ignores a late catalog response from a previous open", async () => {
    // First open's fetch hangs; the user closes and reopens. The second
    // fetch resolves fast with a catalog WITHOUT the slug; the first fetch
    // then resolves late WITH it — it must not pollute the new open.
    let resolveFirst!: (value: { templates: AgentTemplatePublicTemplate[] }) => void;
    templateMocks.listAgentTemplates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    await renderHarness("pr-engineer");
    await click(buttonByText("harness-close"));
    templateMocks.listAgentTemplates.mockResolvedValueOnce({ templates: [TEMPLATE_B] });
    await click(buttonByText("harness-open"));
    await waitForText("no longer available");

    await act(async () => {
      resolveFirst({ templates: [TEMPLATE_A, TEMPLATE_B] });
    });
    await flush();
    await flush();
    // Still the second open's catalog: no PR Engineer preselect, notice kept.
    expect(document.body.textContent).toContain("no longer available");
    expect(document.body.textContent).not.toContain("Tagline of PR Engineer");
  });
});
