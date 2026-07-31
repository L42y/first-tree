// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Popover } from "../popover.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let triggerTop = 208;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function numericStyle(value: string): number {
  return Number.parseFloat(value);
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  triggerTop = 208;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("test-popover-trigger")) {
      return {
        x: 280,
        y: triggerTop,
        top: triggerTop,
        left: 280,
        right: 312,
        bottom: triggerTop + 28,
        width: 32,
        height: 28,
        toJSON: () => undefined,
      } as DOMRect;
    }
    if (this.getAttribute("role") === "dialog") {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 240,
        bottom: 72,
        width: 240,
        height: 72,
        toJSON: () => undefined,
      } as DOMRect;
    }
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => undefined,
    } as DOMRect;
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Popover", () => {
  it("names and focuses the panel, restores focus on Escape, and reflows inside the viewport", async () => {
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <Popover
          className="test-popover-trigger"
          panelAriaLabel="Available sign-in methods"
          focusOnOpen
          panelStyle={{ width: 240 }}
          trigger={({ open, toggle }) => (
            <button type="button" aria-expanded={open} onClick={toggle}>
              Add method
            </button>
          )}
        >
          {() => <button type="button">Google</button>}
        </Popover>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("button");
    if (!trigger) throw new Error("Missing trigger");
    await act(async () => trigger.click());
    await flush();

    const panel = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Available sign-in methods"]');
    const option = panel?.querySelector<HTMLButtonElement>("button");
    expect(panel).toBeTruthy();
    expect(document.activeElement).toBe(option);
    expect(numericStyle(panel?.style.left ?? "")).toBe(72);
    expect(numericStyle(panel?.style.top ?? "")).toBe(132);
    expect(numericStyle(panel?.style.maxHeight ?? "")).toBe(196);
    expect(numericStyle(panel?.style.maxWidth ?? "")).toBe(304);

    triggerTop = 40;
    await act(async () => window.dispatchEvent(new Event("resize")));
    await flush();
    expect(numericStyle(panel?.style.top ?? "")).toBe(72);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
