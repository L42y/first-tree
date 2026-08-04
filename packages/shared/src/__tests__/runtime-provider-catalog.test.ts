import { describe, expect, it } from "vitest";
import {
  asRuntimeProvider,
  DISABLED_RUNTIME_PROVIDERS,
  enabledRuntimeProviders,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_CATALOG,
  RUNTIME_PROVIDER_DISPLAY_ORDER,
  RUNTIME_PROVIDER_IDS,
  RUNTIME_PROVIDER_LABELS,
  RUNTIME_PROVIDERS,
  runtimeProviderInstallCommand,
  runtimeProviderInstallLoginCommand,
  runtimeProviderLabel,
  runtimeProviderLoginCommand,
  runtimeProviderSchema,
} from "../index.js";

describe("runtime provider identity + catalog completeness", () => {
  it("derives schema, named constants, and catalog from one ID set", () => {
    expect([...runtimeProviderSchema.options]).toEqual([...RUNTIME_PROVIDER_IDS]);
    expect(Object.values(RUNTIME_PROVIDERS).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(RUNTIME_PROVIDER_CATALOG).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(RUNTIME_PROVIDER_LABELS).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
  });

  it("keeps display order aligned with catalog ranks and covers every ID", () => {
    expect([...RUNTIME_PROVIDER_DISPLAY_ORDER].sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    const orders = RUNTIME_PROVIDER_DISPLAY_ORDER.map((id) => RUNTIME_PROVIDER_CATALOG[id].displayOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
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

  it("exposes stable install/login metadata without per-provider assertion sprawl", () => {
    for (const id of RUNTIME_PROVIDER_IDS) {
      const entry = RUNTIME_PROVIDER_CATALOG[id];
      expect(entry.id).toBe(id);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.label).toBe(RUNTIME_PROVIDER_LABELS[id]);
      expect(runtimeProviderLabel(id)).toBe(entry.label);
      expect(runtimeProviderLoginCommand(id)).toBe(entry.loginCommand);
      const install = runtimeProviderInstallCommand(id);
      expect(install.length).toBeGreaterThan(0);
      if (entry.npmPackage) {
        expect(install).toContain(entry.npmPackage);
        for (const arg of entry.npmInstallArgs) {
          expect(install).toContain(arg);
        }
      } else {
        expect(install).toBe(entry.scriptInstallCommand);
      }
      expect(runtimeProviderInstallLoginCommand(id)).toBe(`${install}\n${entry.loginCommand}`);
    }
  });

  it("narrows wire strings and leaves unknown ids unlabeled", () => {
    expect(asRuntimeProvider("codex")).toBe("codex");
    expect(asRuntimeProvider("gemini")).toBeNull();
    expect(runtimeProviderLabel("future-provider")).toBe("future-provider");
  });
});
