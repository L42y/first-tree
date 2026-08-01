import { describe, expect, it } from "vitest";
import {
  buildInstallCommand,
  PROVIDER_LABEL,
  providerInstallHint,
  runtimeProviderLabel,
} from "../cards/shared/providers.js";
import { providerSupportsInProductAuth } from "../cards/shared/runtime-auth-view.js";

describe("Pi provider surfaces", () => {
  it("labels Pi and keeps auth host-local", () => {
    expect(PROVIDER_LABEL.pi).toBe("Pi");
    expect(runtimeProviderLabel("pi")).toBe("Pi");
    expect(providerSupportsInProductAuth("pi")).toBe(false);
  });

  it("shows the pinned package family and provider-owned login command", () => {
    expect(buildInstallCommand("pi")).toBe(
      "npm install -g @earendil-works/pi-coding-agent@^0.80.4\npi # then run /login",
    );
    expect(providerInstallHint("pi", "darwin")).toContain("@earendil-works/pi-coding-agent@^0.80.4");
    expect(providerInstallHint("pi", "darwin")).toContain("/login");
    expect(providerInstallHint("pi", "darwin")).toContain("Mac");
  });
});
