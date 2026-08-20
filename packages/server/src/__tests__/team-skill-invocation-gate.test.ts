import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { createTestAgent, seedHealthyAgentRuntime, useTestApp } from "./helpers.js";

/**
 * Rollout gate for Team Skill slash commands (`teamSkillInvocationSupported`
 * on `GET /agents/:uuid/resources`). The Web composer offers Team Skills
 * only when the recipient's bound, route-consistent connected client runs a
 * version that parses the server-owned `teamSkillInvocation` message marker
 * fail-closed. The gate is derived from existing rows only — agent binding +
 * presence + `clients.sdk_version` — with no new persisted state:
 * unbound, offline, unknown-version, pre-epoch, and pre-0.5.22 clients all
 * read as unsupported.
 */
describe("GET /agents/:uuid/resources — teamSkillInvocationSupported gate", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    const { agent, clientId } = await createTestAgent(app, { name: `gate-${crypto.randomUUID().slice(0, 6)}` });
    return { app, agent, clientId };
  }

  async function connectWithVersion(
    app: ReturnType<ReturnType<typeof useTestApp>>,
    agentUuid: string,
    clientId: string,
    sdkVersion: string | null,
  ) {
    await seedHealthyAgentRuntime(app, { agentUuid, clientId });
    await app.db.update(clients).set({ sdkVersion }).where(eq(clients.id, clientId));
  }

  it("is false while the agent has no live route-consistent client", async () => {
    const { app, agent } = await setup();
    const out = await app.resourcesService.getAgentResources(agent.uuid);
    expect(out.teamSkillInvocationSupported).toBe(false);
  });

  it("is true for a connected client on the first marker-reader stable", async () => {
    const { app, agent, clientId } = await setup();
    await connectWithVersion(app, agent.uuid, clientId, "0.5.22");
    const out = await app.resourcesService.getAgentResources(agent.uuid);
    expect(out.teamSkillInvocationSupported).toBe(true);
  });

  it("is false for older, unknown, and pre-epoch client versions", async () => {
    const { app, agent, clientId } = await setup();
    for (const version of ["0.5.21", "0.5.0", "0.14.8", "garbage", "", null]) {
      await connectWithVersion(app, agent.uuid, clientId, version);
      const out = await app.resourcesService.getAgentResources(agent.uuid);
      expect(out.teamSkillInvocationSupported, `version ${JSON.stringify(version)} must be unsupported`).toBe(false);
    }
  });

  it("maps the staging line one patch after the stable base, like the runtime-switch gate", async () => {
    const { app, agent, clientId } = await setup();
    // A staging patch is the next patch after its stable base: 0.5.22-staging
    // predates the 0.5.22 stable reader, 0.5.23-staging contains it.
    await connectWithVersion(app, agent.uuid, clientId, "0.5.22-staging.1.1");
    expect((await app.resourcesService.getAgentResources(agent.uuid)).teamSkillInvocationSupported).toBe(false);
    await connectWithVersion(app, agent.uuid, clientId, "0.5.23-staging.1.1");
    expect((await app.resourcesService.getAgentResources(agent.uuid)).teamSkillInvocationSupported).toBe(true);
  });
});
