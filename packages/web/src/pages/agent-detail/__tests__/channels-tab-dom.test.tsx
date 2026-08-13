// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetailContext } from "../layout-context.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../feishu-section.js", () => ({
  FeishuSection: () => <div>Feishu channel surface</div>,
}));

let root: Root | null = null;

function context(isHuman: boolean): AgentDetailContext {
  return {
    uuid: "agent-a",
    agent: { uuid: "agent-a", type: isHuman ? "human" : "agent" },
    isHuman,
    canManageAgent: true,
    navigateAway: vi.fn(),
  } as unknown as AgentDetailContext;
}

async function renderChannels(isHuman: boolean): Promise<HTMLElement> {
  const { ChannelsTab } = await import("../channels-tab.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={["/agents/agent-a/channels"]}>
        <Routes>
          <Route path="/agents/:uuid" element={<Outlet context={context(isHuman)} />}>
            <Route path="profile" element={<div>Profile destination</div>} />
            <Route path="channels" element={<ChannelsTab />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("Channels tab visibility", () => {
  it("renders the channel surface for a non-human read-only-capable route", async () => {
    const container = await renderChannels(false);
    expect(container.textContent).toContain("Feishu channel surface");
  });

  it("redirects a human-agent deep link back to Profile", async () => {
    const container = await renderChannels(true);
    expect(container.textContent).toContain("Profile destination");
    expect(container.textContent).not.toContain("Feishu channel surface");
  });
});
