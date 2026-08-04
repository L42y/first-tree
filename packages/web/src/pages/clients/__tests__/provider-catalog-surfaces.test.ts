import {
  DISABLED_RUNTIME_PROVIDERS,
  pickPreferredRuntimeProvider,
  RUNTIME_PROVIDER_IDS,
  runtimeProviderLabel as sharedRuntimeProviderLabel,
} from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  asRuntimeProvider,
  buildInstallCommand,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  providerInstallHint,
  runtimeProviderLabel,
} from "../cards/shared/providers.js";

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

  it("picks preferred runtime from catalog display order and skips disabled providers", () => {
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
    ).toBe("claude-code");
    expect(pickPreferredRuntimeProvider({ "future-provider": { state: "ok" } })).toBeNull();
  });

  it("locks install/login copy that cards and onboarding render", () => {
    expect(buildInstallCommand("pi")).toBe(
      "npm install -g --ignore-scripts @earendil-works/pi-coding-agent\npi # then run /login",
    );
    expect(buildInstallCommand("opencode")).toBe("npm install -g opencode-ai@^1.18.7\nopencode auth login");
    expect(buildInstallCommand("cursor")).toContain("curl https://cursor.com/install -fsS | bash");
    expect(buildInstallCommand("grok")).toContain("curl -fsSL https://x.ai/cli/install.sh | bash");
    expect(buildInstallCommand("kimi-code")).toContain("kimi # then run /login");
    expect(buildInstallCommand("claude-code-tui", "darwin")).toContain("brew install tmux");
    expect(providerInstallHint("pi", "darwin")).toContain("--ignore-scripts");
    expect(providerInstallHint("opencode", "linux")).toContain("opencode-ai@^1.18.7");
    expect(providerInstallHint("claude-code-tui", "darwin", "tmux not found")).toContain("brew install tmux");
    expect(providerInstallHint("claude-code-tui", "darwin", "tmux not found")).not.toContain(
      "npm install -g @anthropic-ai/claude-code",
    );
  });
});
