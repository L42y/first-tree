// @vitest-environment happy-dom

import type { CapabilityEntry } from "@first-tree/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSection } from "../../agent-detail/model-section.js";
import {
  buildInstallCommand,
  GROK_INSTALL_COMMAND,
  PROVIDER_LABEL,
  providerInstallHint,
  runtimeProviderLabel,
} from "../cards/shared/providers.js";
import { installBoxView, RuntimeInstallBox } from "../cards/shared/runtime-install-box.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  if (!container) throw new Error("container missing");
  return container;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("grok provider — setup card surfaces", () => {
  it("labels the provider Grok Build", () => {
    expect(PROVIDER_LABEL.grok).toBe("Grok Build");
    expect(runtimeProviderLabel("grok")).toBe("Grok Build");
  });

  it("install command is the official installer script + login, never npm", () => {
    const command = buildInstallCommand("grok", "darwin");
    expect(command).toBe(`${GROK_INSTALL_COMMAND}\ngrok login`);
    expect(command).not.toContain("npm install");
  });

  it("install hint names the official installer for a missing grok", () => {
    const hint = providerInstallHint("grok", "darwin");
    expect(hint).toContain(GROK_INSTALL_COMMAND);
    expect(hint).toContain("Mac");
  });

  it("probe-error install box falls back to the official installer, not an npm spec", () => {
    const entry: CapabilityEntry = {
      state: "error",
      available: false,
      error: "detection threw",
      detectedAt: "2026-07-14T00:00:00.000Z",
    };
    const view = installBoxView(entry, "grok", "devbox");
    expect(view.command).toBe(GROK_INSTALL_COMMAND);
    expect(view.headline).toContain("Grok Build probe failed");
  });

  it("grok on Windows renders the unsupported status with NO install command", async () => {
    const entry: CapabilityEntry = {
      // The exact shape the win32 probe now produces (state error, not missing).
      state: "error",
      available: false,
      error:
        "Grok Build provider is not supported on Windows in V1 (macOS/Linux only). First Tree fails closed on this platform and will not spawn `grok` here.",
      detectedAt: "2026-07-14T00:00:00.000Z",
    };
    const view = installBoxView(entry, "grok", "devbox", "win32");
    expect(view.command).toBeNull();
    expect(view.headline).toContain("not supported on Windows in V1");
    expect(view.headline).not.toContain(GROK_INSTALL_COMMAND);

    // The rendered box shows the status and no setup command box at all.
    const el = await render(<RuntimeInstallBox provider="grok" entry={entry} hostname="devbox" os="win32" />);
    expect(el.textContent).toContain("not supported on Windows in V1");
    expect(el.textContent).not.toContain(GROK_INSTALL_COMMAND);
    expect(el.querySelector("pre")).toBeNull();
  });

  it("grok on Windows still renders the install box for other providers / platforms unchanged", async () => {
    const el = await render(<RuntimeInstallBox provider="grok" entry={null} hostname="devbox" os="darwin" />);
    expect(el.textContent).toContain(GROK_INSTALL_COMMAND);
    expect(el.querySelector("pre")).not.toBeNull();
  });
});

describe("grok provider — DEFAULT + Custom model picker", () => {
  it("exposes unset + custom entry and commits an exact id via Custom", async () => {
    const saved: string[] = [];
    const el = await render(<ModelSection value="" onChange={(v) => saved.push(v)} provider="grok" />);

    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(trigger).not.toBeNull();
    expect(el.querySelector('input[aria-label="Model"]')).toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("(unset — inherits local)");
    expect(body).toContain("Custom model id…");

    const custom = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((b) =>
      b.textContent?.includes("Custom model id…"),
    );
    await act(async () => {
      custom?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(saved).toEqual([]);

    const input = el.querySelector<HTMLInputElement>('input[aria-label="Model"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error("unreachable");
    expect(input.placeholder).toContain("auto");

    await act(async () => {
      // React tracks the value setter — go through the native prototype setter
      // so the synthetic onChange fires for a controlled input.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, " grok-4-heavy ");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: " grok-4-heavy ", inputType: "insertText" }));
    });
    // No save yet — the field commits on Enter/blur, not per keystroke.
    expect(saved).toEqual([]);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // Trimmed exact id, committed once; custom mode then returns to the Select.
    expect(saved).toEqual(["grok-4-heavy"]);
    expect(el.querySelector('button[aria-label="Model"]')).not.toBeNull();
  });

  it("keeps the dropdown for claude/codex providers (no free-form regression)", async () => {
    const el = await render(<ModelSection value="opus" onChange={() => {}} provider="claude-code" />);
    expect(el.querySelector('input[aria-label="Model"]')).toBeNull();
  });
});
