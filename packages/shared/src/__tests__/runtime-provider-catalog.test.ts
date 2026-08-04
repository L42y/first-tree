import { describe, expect, it } from "vitest";
import {
  asRuntimeProvider,
  DISABLED_RUNTIME_PROVIDERS,
  enabledRuntimeProviders,
  isRuntimeProviderEnabled,
  OPENCODE_MINIMUM_VERSION,
  OPENCODE_NPM_PACKAGE,
  pickPreferredRuntimeProvider,
  RUNTIME_PROVIDER_CATALOG,
  RUNTIME_PROVIDER_DISPLAY_ORDER,
  RUNTIME_PROVIDER_IDS,
  RUNTIME_PROVIDER_LABELS,
  RUNTIME_PROVIDER_SELECTION_ORDER,
  RUNTIME_PROVIDERS,
  runtimeProviderAuthOwnerLabel,
  runtimeProviderChatAuthLoginPhrase,
  runtimeProviderInstallCommand,
  runtimeProviderInstallLoginCommand,
  runtimeProviderLabel,
  runtimeProviderLoginCommand,
  runtimeProviderLoginSteps,
  runtimeProviderSchema,
} from "../index.js";

describe("runtime provider identity + catalog completeness", () => {
  it("derives schema, named constants, and catalog from one Zod source", () => {
    expect([...runtimeProviderSchema.options]).toEqual([...RUNTIME_PROVIDER_IDS]);
    expect(Object.values(RUNTIME_PROVIDERS).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(RUNTIME_PROVIDER_CATALOG).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(RUNTIME_PROVIDER_LABELS).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
  });

  it("keeps display order and selection priority distinct and exhaustive", () => {
    expect([...RUNTIME_PROVIDER_DISPLAY_ORDER].sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect([...RUNTIME_PROVIDER_SELECTION_ORDER].sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    const displayOrders = RUNTIME_PROVIDER_DISPLAY_ORDER.map((id) => RUNTIME_PROVIDER_CATALOG[id].displayOrder);
    expect(displayOrders).toEqual([...displayOrders].sort((a, b) => a - b));
    const selectionOrders = RUNTIME_PROVIDER_SELECTION_ORDER.map(
      (id) => RUNTIME_PROVIDER_CATALOG[id].selectionPriority,
    );
    expect(selectionOrders).toEqual([...selectionOrders].sort((a, b) => a - b));

    // Phase-1 display: … Grok → Kimi → OpenCode → Pi
    expect(RUNTIME_PROVIDER_DISPLAY_ORDER.indexOf("kimi-code")).toBeLessThan(
      RUNTIME_PROVIDER_DISPLAY_ORDER.indexOf("opencode"),
    );
    // Phase-1 selection: … Grok → OpenCode → Pi → Kimi
    expect(RUNTIME_PROVIDER_SELECTION_ORDER).toEqual([
      "claude-code",
      "claude-code-tui",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
      "kimi-code",
    ]);
  });

  it("treats disabled providers as a subset of known IDs", () => {
    for (const disabled of DISABLED_RUNTIME_PROVIDERS) {
      expect(RUNTIME_PROVIDER_IDS).toContain(disabled);
      expect(isRuntimeProviderEnabled(disabled)).toBe(false);
    }
    expect(enabledRuntimeProviders()).toEqual(
      RUNTIME_PROVIDER_DISPLAY_ORDER.filter((id) => isRuntimeProviderEnabled(id)),
    );
    expect(enabledRuntimeProviders()).not.toContain("claude-code-tui");
  });

  it("exposes stable install/login metadata from structured catalog fields", () => {
    for (const id of RUNTIME_PROVIDER_IDS) {
      const entry = RUNTIME_PROVIDER_CATALOG[id];
      expect(entry.id).toBe(id);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.label).toBe(RUNTIME_PROVIDER_LABELS[id]);
      expect(runtimeProviderLabel(id)).toBe(entry.label);
      expect(entry.loginSteps.length).toBeGreaterThan(0);
      expect(runtimeProviderLoginSteps(id)).toEqual(entry.loginSteps);
      const install = runtimeProviderInstallCommand(id);
      expect(install.length).toBeGreaterThan(0);
      if (entry.install.kind === "npm") {
        expect(install).toContain(entry.install.package);
        for (const arg of entry.install.args) {
          expect(install).toContain(arg);
        }
      } else {
        expect(install).toBe(entry.install.command);
      }
      expect(runtimeProviderInstallLoginCommand(id)).toBe(`${install}\n${runtimeProviderLoginCommand(id)}`);
      expect(runtimeProviderAuthOwnerLabel(id).length).toBeGreaterThan(0);
      expect(runtimeProviderChatAuthLoginPhrase(id)).toContain("`");
    }
  });

  it("narrows wire strings via safeParse and leaves unknown ids unlabeled", () => {
    expect(asRuntimeProvider("codex")).toBe("codex");
    expect(asRuntimeProvider("gemini")).toBeNull();
    expect(runtimeProviderLabel("future-provider")).toBe("future-provider");
  });

  it("locks product-critical strings, OpenCode version, and preferred-runtime priority", () => {
    expect(OPENCODE_MINIMUM_VERSION).toBe("1.18.7");
    expect(OPENCODE_NPM_PACKAGE).toBe(`opencode-ai@^${OPENCODE_MINIMUM_VERSION}`);
    expect(runtimeProviderInstallCommand("pi")).toBe("npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
    expect(runtimeProviderInstallCommand("opencode")).toBe(`npm install -g ${OPENCODE_NPM_PACKAGE}`);
    expect(runtimeProviderInstallCommand("cursor")).toBe("curl https://cursor.com/install -fsS | bash");
    expect(runtimeProviderInstallCommand("grok")).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
    expect(runtimeProviderLoginCommand("kimi-code")).toBe("kimi # then run /login");
    expect(runtimeProviderLoginCommand("pi")).toBe("pi # then run /login");
    expect(runtimeProviderChatAuthLoginPhrase("kimi-code")).toBe("`kimi` and then `/login`");
    expect(runtimeProviderChatAuthLoginPhrase("codex")).toBe("`codex login`");
    expect(RUNTIME_PROVIDER_CATALOG["claude-code-tui"].install).toEqual({
      kind: "npm",
      package: "@anthropic-ai/claude-code",
      args: [],
    });
    expect(isRuntimeProviderEnabled("claude-code-tui")).toBe(false);

    expect(
      pickPreferredRuntimeProvider({
        "claude-code-tui": { state: "ok" },
        codex: { state: "ok" },
      }),
    ).toBe("codex");
    expect(
      pickPreferredRuntimeProvider({
        grok: { state: "ok" },
        "kimi-code": { state: "ok" },
        opencode: { state: "ok" },
        pi: { state: "ok" },
      }),
    ).toBe("grok");
    expect(
      pickPreferredRuntimeProvider({
        "kimi-code": { state: "ok" },
        opencode: { state: "ok" },
        pi: { state: "ok" },
      }),
    ).toBe("opencode");
    expect(
      pickPreferredRuntimeProvider({
        "kimi-code": { state: "ok" },
        pi: { state: "ok" },
      }),
    ).toBe("pi");
  });
});
