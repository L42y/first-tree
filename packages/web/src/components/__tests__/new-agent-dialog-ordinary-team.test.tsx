// @vitest-environment happy-dom

import type { Agent } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
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

const NOW = "2026-08-14T00:00:00.000Z";
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
    capabilities: { codex: capability() },
  };
}

function createdAgent(): Agent {
  return {
    uuid: "agent-created-1",
    name: "build-bot",
    displayName: "Build Bot",
    type: "agent",
    managerId: "member-self",
    visibility: "organization",
    avatarColorToken: null,
    avatarImageUrl: null,
    status: "active",
    organizationId: "org-1",
    delegateMention: null,
    inboxId: "inbox-1",
    metadata: {},
    source: "portal",
    clientId: "client-1",
    runtimeProvider: "codex",
    runtimeState: "idle",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDialog(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <NewAgentDialog open onOpenChange={() => undefined} onCreated={() => undefined} />
        </ToastProvider>
      </QueryClientProvider>,
    );
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

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

describe("NewAgentDialog ordinary Team entry", () => {
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

  it("does not fetch or render Templates and submits Team-visible by default", async () => {
    await renderDialog();

    expect(templateMocks.listAgentTemplates).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Responsibilities");
    expect(document.body.textContent).not.toContain("Choose a template");
    const teamVisible = [...document.body.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("Visible to your team"),
    );
    expect(teamVisible?.querySelector<HTMLInputElement>('input[name="visibility"]')?.checked).toBe(true);

    const displayName = document.body.querySelector<HTMLInputElement>("#new-agent-display-name");
    if (!displayName) throw new Error("Missing display-name input");
    await setValue(displayName, "Build Bot");
    await click(
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Create") ?? null,
    );

    expect(agentMocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "build-bot",
        displayName: "Build Bot",
        visibility: "organization",
        runtimeProvider: "codex",
      }),
    );
    expect(agentMocks.createAgent.mock.calls[0]?.[0]).not.toHaveProperty("templateIds");
  });

  it("keeps Private available as an explicit choice", async () => {
    await renderDialog();
    const privateInput = [...document.body.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Private to you"))
      ?.querySelector<HTMLInputElement>('input[name="visibility"]');
    await click(privateInput ?? null);
    expect(privateInput?.checked).toBe(true);
  });
});
