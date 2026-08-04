// @vitest-environment happy-dom

import {
  DISABLED_RUNTIME_PROVIDERS,
  enabledOkRuntimeProviders,
  pickPreferredRuntimeProvider,
  RUNTIME_PROVIDER_IDS,
  RUNTIME_PROVIDER_SELECTION_ORDER,
  runtimeProviderInstallLoginCommand,
  runtimeProviderLabel as sharedRuntimeProviderLabel,
} from "@first-tree/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRuntimeProvider,
  buildInstallCommand,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  providerInstallHint,
  runtimeProviderLabel,
} from "../cards/shared/providers.js";
import { RuntimeInstallBox } from "../cards/shared/runtime-install-box.js";

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
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe("web provider surfaces derived from shared catalog", () => {
  it("offers only enabled providers and keeps disabled labels for already-bound agents", () => {
    expect(PROVIDER_ORDER).not.toContain("claude-code-tui");
    for (const disabled of DISABLED_RUNTIME_PROVIDERS) {
      expect(PROVIDER_ORDER).not.toContain(disabled);
      expect(PROVIDER_LABEL[disabled].length).toBeGreaterThan(0);
    }
    expect(PROVIDER_ORDER.length).toBe(RUNTIME_PROVIDER_IDS.length - DISABLED_RUNTIME_PROVIDERS.length);
  });

  it("preserves unknown-provider fallback labeling across shared helpers", () => {
    expect(asRuntimeProvider("future-provider")).toBeNull();
    expect(runtimeProviderLabel("future-provider")).toBe("future-provider");
    expect(sharedRuntimeProviderLabel("future-provider")).toBe("future-provider");
    expect(runtimeProviderLabel("codex")).toBe("Codex");
    expect(sharedRuntimeProviderLabel("codex")).toBe(PROVIDER_LABEL.codex);
  });

  it("picks preferred runtime from catalog selectionPriority (not display order)", () => {
    expect(
      pickPreferredRuntimeProvider({
        "claude-code-tui": { state: "ok" },
        codex: { state: "ok" },
      }),
    ).toBe("codex");
    expect(
      pickPreferredRuntimeProvider({
        "claude-code": { state: "ok" },
        codex: { state: "ok" },
      }),
    ).toBe("codex");
    // Display order places Kimi before OpenCode/Pi; selection keeps OpenCode → Pi → Kimi.
    expect(
      pickPreferredRuntimeProvider({
        "kimi-code": { state: "ok" },
        opencode: { state: "ok" },
        pi: { state: "ok" },
      }),
    ).toBe("opencode");
    expect(pickPreferredRuntimeProvider({ "future-provider": { state: "ok" } })).toBeNull();
  });

  it("orders NewAgentDialog-style ok options by catalog selection order, not cap key insertion", () => {
    const shuffled = {
      pi: { state: "ok" as const },
      "kimi-code": { state: "ok" as const },
      grok: { state: "ok" as const },
      "claude-code": { state: "ok" as const },
    };
    expect(enabledOkRuntimeProviders(shuffled)).toEqual(["claude-code", "grok", "pi", "kimi-code"]);
    expect(enabledOkRuntimeProviders(shuffled)).toEqual(
      RUNTIME_PROVIDER_SELECTION_ORDER.filter((id) => shuffled[id as keyof typeof shuffled]?.state === "ok"),
    );
  });

  it("locks install/login copy that cards and onboarding render", () => {
    expect(buildInstallCommand("pi")).toBe(
      "npm install -g --ignore-scripts @earendil-works/pi-coding-agent\npi # then run /login",
    );
    expect(buildInstallCommand("opencode")).toBe("npm install -g opencode-ai@^1.18.7\nopencode auth login");
    expect(buildInstallCommand("cursor")).toBe("curl https://cursor.com/install -fsS | bash");
    expect(buildInstallCommand("grok")).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
    expect(buildInstallCommand("cursor")).not.toContain("cursor-agent login");
    expect(buildInstallCommand("grok")).not.toContain("grok login");
    expect(buildInstallCommand("codex")).toBe("npm install -g @openai/codex");
    expect(buildInstallCommand("codex")).not.toContain("codex login");
    expect(buildInstallCommand("kimi-code")).toContain("kimi # then run /login");
    expect(buildInstallCommand("claude-code-tui", "darwin")).toContain("brew install tmux");
    expect(buildInstallCommand("claude-code-tui", "darwin")).not.toContain("claude auth login");
    expect(providerInstallHint("pi", "darwin")).toContain("--ignore-scripts");
    expect(providerInstallHint("pi", "darwin")).toContain("run `pi` and enter `/login`");
    expect(providerInstallHint("kimi-code", "linux")).toContain("run `kimi` and enter `/login`");
    expect(providerInstallHint("codex", "darwin")).toContain("npm install -g @openai/codex");
    expect(providerInstallHint("codex", "darwin")).not.toContain("codex login");
    expect(providerInstallHint("codex", "darwin")).not.toContain("Install the OpenAI Codex CLI");
    expect(providerInstallHint("opencode", "linux")).toContain("opencode-ai@^1.18.7");
    expect(providerInstallHint("claude-code-tui", "darwin", "tmux not found")).toContain("brew install tmux");
    expect(providerInstallHint("claude-code-tui", "darwin", "tmux not found")).not.toContain(
      "npm install -g @anthropic-ai/claude-code",
    );
  });

  it("renders RuntimeInstallBox install-only for in-product auth providers", async () => {
    const expected = runtimeProviderInstallLoginCommand("codex");
    expect(expected).toBe("npm install -g @openai/codex");
    const el = await render(<RuntimeInstallBox provider="codex" entry={null} hostname="devbox" os="darwin" />);
    const text = el.textContent ?? "";
    expect(text).toContain("Codex");
    expect(text).toContain(expected);
    expect(text).not.toContain("codex login");
    const pre = el.querySelector("pre");
    expect(pre?.textContent).toBe("npm install -g @openai/codex");
  });
});
