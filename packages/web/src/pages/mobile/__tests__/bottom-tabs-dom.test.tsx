// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement, route: string): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        {element}
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("MobileBottomTabs Ask agent lock", () => {
  it("swaps every tab for an inert disabled button while locked", async () => {
    const { MobileBottomTabs } = await import("../components.js");
    const { container, root } = await renderDom(<MobileBottomTabs chatCount={2} locked />, "/m/chat?review=need-you");

    // No navigable anchors remain: tap, keyboard, and programmatic activation
    // all fail closed, including the active Chat tab.
    expect(container.querySelector("a")).toBeNull();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
    }
    expect(container.querySelector('button[aria-label^="Team"]')?.getAttribute("aria-label")).toContain(
      "unavailable while waiting for the agent reply",
    );
    // The unread badge stays visible as information, not navigation.
    expect(container.textContent).toContain("2");

    await click(container.querySelector('button[aria-label^="Team"]'));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/m/chat?review=need-you");

    await act(async () => root.unmount());
  });

  it("renders ordinary tab links when unlocked", async () => {
    const { MobileBottomTabs } = await import("../components.js");
    const { container, root } = await renderDom(<MobileBottomTabs chatCount={0} />, "/m/chat");

    const hrefs = [...container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"));
    expect(hrefs).toEqual(["/m/chat", "/m/team", "/m/me"]);
    expect(container.querySelector("button")).toBeNull();

    await act(async () => root.unmount());
  });
});
