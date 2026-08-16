import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLocalContextDataLoss, localContextDataLossForAgent } from "../core/local-context/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Local Context lifecycle inventory", () => {
  it("finds active and parked Agent Local Context roots before destructive cleanup", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-local-lifecycle-"));
    roots.push(home);
    const dataDir = join(home, "data");
    const active = join(dataDir, "workspaces", "agent-a", "local-context");
    const parked = join(home, "parked-clients", "client_old", "data", "workspaces", "agent-b", "local-context");
    mkdirSync(active, { recursive: true });
    mkdirSync(parked, { recursive: true });

    expect(listLocalContextDataLoss({ dataDir, home })).toEqual([
      { agentName: "agent-a", path: active, storage: "active" },
      { agentName: "agent-b", path: parked, storage: "parked" },
    ]);
    expect(localContextDataLossForAgent(join(dataDir, "workspaces"), "agent-a")).toEqual({
      agentName: "agent-a",
      path: active,
      storage: "active",
    });
  });

  it("keeps Client switch rooted at the whole workspaces directory with no Local-specific mover", () => {
    const source = readFileSync(new URL("../core/client-switch.ts", import.meta.url), "utf8");
    expect(source).toContain('join(opts.dataDir, "workspaces")');
    expect(source).toContain('join(fromParkedRoot, "data", "workspaces")');
    expect(source).toContain('join(toParkedRoot, "data", "workspaces")');
    expect(source).not.toContain('join(opts.dataDir, "workspaces", "local-context")');
  });
});
