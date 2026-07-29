// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildByoSetupPrompt } from "../../lib/byo-setup-prompt.js";
import { ContextEnablement, ContextPersonalAccess } from "../settings/context-enablement.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({ generateConnectToken: vi.fn() }));
const apiMocks = vi.hoisted(() => ({ getContextEnablementHandoff: vi.fn() }));
vi.mock("../../api/activity.js", () => activityMocks);
vi.mock("../../api/context-enablement.js", () => apiMocks);

describe("ContextEnablement", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    activityMocks.generateConnectToken.mockResolvedValue({
      bootstrapCommand: "'first-tree-staging' login 'short-lived-code'",
      installerUrl: "https://example.com/install.sh",
      binName: "first-tree-staging",
    });
    apiMocks.getContextEnablementHandoff.mockResolvedValue({
      organizationId: "org-1",
      teamDisplayName: "Acme",
      role: "member",
      provider: "claude-code",
      command: "'first-tree-staging' context enable --provider 'claude-code' --team 'org-1'",
      workingDirectoryInstruction: "Run this once from the repository root.",
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  async function render(props: { teamRole: string; ready: boolean; computerConnected: boolean }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextEnablement organizationId="org-1" {...props} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("renders the server-authored exact Team handoff for a connected computer", async () => {
    await render({ teamRole: "member", ready: true, computerConnected: true });
    expect(host.textContent).toContain("Run this once from the repository root.");
    expect(host.textContent).toContain("context enable --provider 'claude-code' --team 'org-1'");
    expect(apiMocks.getContextEnablementHandoff).toHaveBeenCalledWith("org-1", "claude-code");
  });

  it("shows Needs Admin to a member without querying a handoff", async () => {
    await render({ teamRole: "member", ready: false, computerConnected: true });
    expect(host.textContent).toContain("Needs Admin");
    expect(apiMocks.getContextEnablementHandoff).not.toHaveBeenCalled();
  });

  it("copies one provider-neutral prompt containing both exact server-authored commands", async () => {
    apiMocks.getContextEnablementHandoff.mockImplementation(
      async (_organizationId: string, provider: "claude-code" | "codex") => ({
        organizationId: "org-1",
        teamDisplayName: "Acme",
        role: "admin",
        provider,
        command: `'first-tree-staging' context enable --provider '${provider}' --team 'org-1'`,
        workingDirectoryInstruction: "Run this once from the repository root.",
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-1" />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain("Use in your coding agent");
    expect(host.textContent).not.toContain("context enable --provider");
    const copy = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy setup prompt",
    );
    await act(async () => {
      copy?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const copiedPrompt = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
    expect(copiedPrompt).toContain("'first-tree-staging' login 'short-lived-code'");
    expect(copiedPrompt).toContain("If you are Claude Code:");
    expect(copiedPrompt).toContain("--provider 'claude-code' --team 'org-1'");
    expect(copiedPrompt).toContain("If you are Codex:");
    expect(copiedPrompt).toContain("--provider 'codex' --team 'org-1'");
    expect(copiedPrompt).toContain("Do not run both and do not add, remove, or change command flags.");
    expect(copiedPrompt).toContain("Do not mark onboarding complete.");
    expect(host.textContent).toContain("Copied");
    expect(activityMocks.generateConnectToken).toHaveBeenCalledTimes(1);
    expect(apiMocks.getContextEnablementHandoff).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched Team handoffs instead of copying an ambiguous prompt", () => {
    expect(() =>
      buildByoSetupPrompt({
        organizationId: "org-1",
        bootstrapCommand: "bootstrap-command",
        handoffs: [
          {
            organizationId: "org-1",
            teamDisplayName: "Acme",
            role: "admin",
            provider: "claude-code",
            command: "claude-command",
            workingDirectoryInstruction: "Run from the repository root.",
          },
          {
            organizationId: "org-2",
            teamDisplayName: "Other",
            role: "admin",
            provider: "codex",
            command: "codex-command",
            workingDirectoryInstruction: "Run from the repository root.",
          },
        ],
        intent: "settings",
      }),
    ).toThrow("expected Team");
  });

  it("builds a one-provider onboarding artifact without exposing the other provider", () => {
    const prompt = buildByoSetupPrompt({
      organizationId: "org-1",
      bootstrapCommand: "bootstrap-command",
      handoffs: [
        {
          organizationId: "org-1",
          teamDisplayName: "Acme",
          role: "member",
          provider: "claude-code",
          command: "claude-command",
          workingDirectoryInstruction: "Run from the repository root.",
        },
      ],
      intent: "onboarding",
    });

    expect(prompt).toContain("bootstrap-command");
    expect(prompt).toContain("claude-command");
    expect(prompt).not.toContain("Codex");
    expect(prompt).toContain("onboarding completion has been recorded");
    expect(prompt).not.toContain("Do not mark onboarding complete.");
  });

  it("lets the Admin retry prompt preparation after an API failure", async () => {
    const preparePrompt = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("ready-prompt");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-1" preparePrompt={preparePrompt} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    const copy = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy setup prompt",
    );
    await act(async () => {
      copy?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain("Copied");
    expect(preparePrompt).toHaveBeenCalledTimes(2);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ready-prompt");
  });

  it("does not copy a stale Team prompt after the Settings consumer switches Team", async () => {
    let resolveTeamA: ((prompt: string) => void) | undefined;
    const preparePrompt = vi.fn(
      (organizationId: string) =>
        new Promise<string>((resolve) => {
          if (organizationId === "org-a") resolveTeamA = resolve;
        }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-a" preparePrompt={preparePrompt} />
        </QueryClientProvider>,
      );
    });
    const copy = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy setup prompt",
    );
    await act(async () => copy?.click());

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-b" preparePrompt={preparePrompt} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      resolveTeamA?.("stale-org-a-prompt");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Copy setup prompt");
  });

  it("does not copy a prompt after the Settings consumer unmounts", async () => {
    let resolvePrompt: ((prompt: string) => void) | undefined;
    const preparePrompt = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-a" preparePrompt={preparePrompt} />
        </QueryClientProvider>,
      );
    });
    const copy = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy setup prompt",
    );
    await act(async () => copy?.click());
    await act(async () => root.render(null));
    await act(async () => {
      resolvePrompt?.("unmounted-prompt");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
