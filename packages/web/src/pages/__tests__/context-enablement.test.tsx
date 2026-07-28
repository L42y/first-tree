// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextEnablement } from "../settings/context-enablement.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({ getContextEnablementHandoff: vi.fn() }));
vi.mock("../../api/context-enablement.js", () => apiMocks);

describe("ContextEnablement", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
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
});
