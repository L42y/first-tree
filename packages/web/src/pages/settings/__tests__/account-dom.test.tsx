// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    user: {
      id: "user-self",
      username: "gandy2025",
      displayName: "Gandy",
      avatarUrl: null as string | null,
    },
    refreshMe: vi.fn(async () => undefined),
  },
}));

const memberMocks = vi.hoisted(() => ({
  updateMyProfile: vi.fn(async () => ({ id: "user-self", displayName: "Gandy New" })),
}));

const providerMocks = vi.hoisted(() => ({
  getAuthProviders: vi.fn(),
  startProviderLink: vi.fn(),
  startProviderUnlink: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../api/members.js", () => memberMocks);
vi.mock("../../../api/user-settings.js", () => providerMocks);

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAccount(
  route = "/settings/account",
): Promise<{ container: HTMLElement; queryClient: QueryClient }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["chat-detail", "chat-1"], { id: "chat-1", participants: [] });
  const { SettingsAccountPage } = await import("../account.js");
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <SettingsAccountPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return { container, queryClient };
}

async function waitForText(container: ParentNode, text: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  root = null;
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  authMock.value.user = {
    id: "user-self",
    username: "gandy2025",
    displayName: "Gandy",
    avatarUrl: null,
  };
  providerMocks.getAuthProviders.mockResolvedValue({
    providers: [
      {
        provider: "google",
        available: true,
        connected: true,
        accountName: "gandy@example.com",
        email: "gandy@example.com",
        avatarUrl: null,
        connectedAt: "2026-07-15T12:00:00.000Z",
        canUnlink: false,
        unlinkBlockedReason: "last-provider",
      },
      {
        provider: "github",
        available: true,
        connected: false,
        accountName: null,
        email: null,
        avatarUrl: null,
        connectedAt: null,
        canUnlink: false,
        unlinkBlockedReason: null,
      },
    ],
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Settings account", () => {
  it("separates identity from the editable profile and saves a normalized display name", async () => {
    const { container, queryClient } = await renderAccount();
    await waitForText(container, "gandy@example.com");

    expect(container.textContent).toContain("Gandy");
    expect(container.textContent).toContain("@gandy2025");
    expect(container.textContent).toContain("Your avatar comes from the provider you signed up with.");
    expect(container.textContent).toContain("Profile");
    expect(container.textContent).toContain("Ways to sign in");
    expect(container.textContent).toContain("Use any available connected account to sign in to First Tree.");
    expect(container.textContent).toContain("Add another sign-in method");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("Connected 7/15/2026");
    expect(container.textContent).not.toContain("Connect another sign-in method before disconnecting.");
    expect(container.textContent).not.toContain("Sign-in methods");
    expect(container.textContent).not.toContain("Authentication connections");

    const inputs = container.querySelectorAll<HTMLInputElement>("input");
    expect(inputs).toHaveLength(1);
    const displayNameInput = inputs[0];
    if (!displayNameInput) throw new Error("Expected display name input");
    expect(displayNameInput.maxLength).toBe(200);

    const saveButton = container.querySelector<HTMLButtonElement>('button[aria-label="Save"]');
    if (!saveButton) throw new Error("Expected save button");
    expect(saveButton.disabled).toBe(true);

    const disconnect = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
      button.textContent?.includes("Disconnect"),
    );
    expect(disconnect).toHaveLength(0);

    await setInputValue(displayNameInput, "  Gandy   New  ");
    expect(saveButton.disabled).toBe(false);

    const form = container.querySelector("form");
    if (!form) throw new Error("Expected profile form");
    await act(async () => {
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(memberMocks.updateMyProfile).toHaveBeenCalledWith({ displayName: "Gandy New" });
    expect(authMock.value.refreshMe).toHaveBeenCalled();
    expect(queryClient.getQueryState(["chat-detail", "chat-1"])?.isInvalidated).toBe(true);
    expect(container.textContent).toContain("Saved");
  });

  it("offers only unconnected available providers from the compact picker", async () => {
    providerMocks.startProviderLink.mockReturnValue(new Promise<never>(() => undefined));
    const { container } = await renderAccount();
    await waitForText(container, "Add another sign-in method");

    const addMethod = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add another sign-in method",
    );
    if (!addMethod) throw new Error("Expected add sign-in method button");
    expect(addMethod.getAttribute("aria-expanded")).toBe("false");

    await act(async () => addMethod.click());
    await flush();

    expect(addMethod.getAttribute("aria-expanded")).toBe("true");
    const picker = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Available sign-in methods"]');
    const githubOption = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "GitHub",
    );
    const googleOption = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Google",
    );
    expect(picker).toBeTruthy();
    expect(githubOption).toBeTruthy();
    expect(googleOption).toBeUndefined();
    expect(document.activeElement).toBe(githubOption);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();

    expect(document.body.querySelector('[role="dialog"][aria-label="Available sign-in methods"]')).toBeNull();
    expect(addMethod.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(addMethod);

    await act(async () => addMethod.click());
    await flush();
    const reopenedGithubOption = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "GitHub",
    );

    await act(async () => reopenedGithubOption?.click());
    await flush();

    expect(providerMocks.startProviderLink).toHaveBeenCalledWith("github");
    expect(addMethod.getAttribute("aria-expanded")).toBe("false");
    expect(addMethod.textContent).toContain("Starting…");
  });

  it("names and routes disconnect actions only when another usable credential remains", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    providerMocks.startProviderUnlink.mockReturnValue(new Promise<never>(() => undefined));
    providerMocks.getAuthProviders.mockResolvedValue({
      providers: [
        {
          provider: "google",
          available: true,
          connected: true,
          accountName: "gandy@example.com",
          email: "gandy@example.com",
          avatarUrl: null,
          connectedAt: "2026-07-15T12:00:00.000Z",
          canUnlink: true,
          unlinkBlockedReason: null,
        },
        {
          provider: "github",
          available: true,
          connected: true,
          accountName: "Gandy2025",
          email: null,
          avatarUrl: null,
          connectedAt: "2026-07-16T12:00:00.000Z",
          canUnlink: true,
          unlinkBlockedReason: null,
        },
      ],
    });

    const { container } = await renderAccount();
    await waitForText(container, "Gandy2025");

    const disconnect = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => button.textContent?.trim() === "Disconnect",
    );
    expect(disconnect).toHaveLength(2);
    expect(container.querySelector('button[aria-label="Disconnect Google"]')).toBeTruthy();
    const disconnectGithub = container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect GitHub"]');
    expect(disconnectGithub).toBeTruthy();
    expect(container.textContent).not.toContain("Add another sign-in method");

    await act(async () => disconnectGithub?.click());
    await flush();

    expect(confirm).toHaveBeenCalledWith("Disconnect GitHub?");
    expect(providerMocks.startProviderUnlink).toHaveBeenCalledWith("github");
  });

  it("does not promise that a connected but unavailable provider can sign in", async () => {
    providerMocks.getAuthProviders.mockResolvedValue({
      providers: [
        {
          provider: "google",
          available: false,
          connected: true,
          accountName: "gandy@example.com",
          email: "gandy@example.com",
          avatarUrl: null,
          connectedAt: "2026-07-15T12:00:00.000Z",
          canUnlink: false,
          unlinkBlockedReason: null,
        },
        {
          provider: "github",
          available: true,
          connected: false,
          accountName: null,
          email: null,
          avatarUrl: null,
          connectedAt: null,
          canUnlink: false,
          unlinkBlockedReason: null,
        },
      ],
    });

    const { container } = await renderAccount();
    await waitForText(container, "currently unavailable");

    expect(container.textContent).toContain("Your connected sign-in methods are currently unavailable.");
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).not.toContain("Use any available connected account");
  });

  it("keeps provider load failures distinct from an empty deployment", async () => {
    providerMocks.getAuthProviders.mockRejectedValue(new Error("Could not reach account settings."));

    const { container } = await renderAccount();
    await waitForText(container, "Could not reach account settings.");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not reach account settings.");
    expect(container.textContent).not.toContain("No additional sign-in methods are available.");
  });

  it("shows callback errors and removes the transient query from browser history", async () => {
    const { container } = await renderAccount("/settings/account?error=identity-conflict");
    await waitForText(container, "already connected to another First Tree user");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "That account is already connected to another First Tree user.",
    );
    expect(window.location.pathname).toBe("/settings/account");
    expect(window.location.search).toBe("");
  });
});
