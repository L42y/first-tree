import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * An Agent can be created before its Computer is known — OpenTag does exactly
 * that. Its runtime provider then still holds the service default, so the
 * first bind has to be able to commit the provider that the chosen Computer
 * actually reports, or that Agent can never bind to a Computer running
 * anything else.
 *
 * The write stays confined to the one-shot first bind: moving a bound Agent's
 * provider is the managed switch flow's job, because that has to drain
 * sessions and revoke the old runtime proof.
 */
describe("PATCH /agents/:uuid { clientId, runtimeProvider } — first bind", () => {
  const getApp = useTestApp();

  async function unbind(app: ReturnType<typeof getApp>, uuid: string): Promise<void> {
    await app.db.update(agents).set({ clientId: null }).where(eq(agents.uuid, uuid));
  }

  it("commits the provider together with the first bind", async () => {
    const app = getApp();
    const { agent, accessToken, clientId } = await createTestAgent(app, { name: `fb-${Date.now()}` });
    await unbind(app, agent.uuid);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId, runtimeProvider: "codex" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ clientId: string; runtimeProvider: string }>();
    expect(body.clientId).toBe(clientId);
    expect(body.runtimeProvider).toBe("codex");
  });

  it("validates the supplied provider against the Computer, not the stored default", async () => {
    const app = getApp();
    const { agent, accessToken, clientId } = await createTestAgent(app, { name: `cap-${Date.now()}` });
    await unbind(app, agent.uuid);
    // A Codex-only Computer: the Agent's default provider is not installed there.
    await app.db
      .update(clients)
      .set({
        metadata: {
          capabilities: {
            codex: { available: true, state: "ok" },
            "claude-code": { available: false, state: "missing" },
          },
        },
      })
      .where(eq(clients.id, clientId));

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toMatch(/does not have runtime provider "claude-code"/i);

    const accepted = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId, runtimeProvider: "codex" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ runtimeProvider: string }>().runtimeProvider).toBe("codex");
  });

  it("retags the durable runtime config so the row and the config agree", async () => {
    const app = getApp();
    const { agent, accessToken, clientId } = await createTestAgent(app, { name: `cfg-${Date.now()}` });
    await unbind(app, agent.uuid);
    const [before] = await app.db
      .select({ payload: agentConfigs.payload, version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(before?.payload).toMatchObject({ kind: "claude-code" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId, runtimeProvider: "codex" },
    });
    expect(res.statusCode).toBe(200);

    // Creation initialized the config from the previous provider. Leaving it
    // behind would give the Agent a row saying `codex` and a durable config
    // still carrying the old kind and defaults.
    const [after] = await app.db
      .select({ payload: agentConfigs.payload, version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(after?.payload).toMatchObject({ kind: "codex" });
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it("lets only one concurrent first bind win", async () => {
    const app = getApp();
    const { agent, accessToken, clientId } = await createTestAgent(app, { name: `race-${Date.now()}` });
    await unbind(app, agent.uuid);

    // Both requests read a NULL clientId before either takes a lock. Without
    // a locked re-check the loser would overwrite a live route, bypassing the
    // managed switch flow's session draining and proof revocation.
    const [first, second] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/v1/agents/${agent.uuid}`,
        headers: { Authorization: `Bearer ${accessToken}` },
        payload: { clientId, runtimeProvider: "codex" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/v1/agents/${agent.uuid}`,
        headers: { Authorization: `Bearer ${accessToken}` },
        payload: { clientId, runtimeProvider: "claude-code" },
      }),
    ]);

    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 200]);
    // Converging on the same target Computer is fine; the provider must not
    // have been rewritten twice.
    const [row] = await app.db
      .select({ clientId: agents.clientId, runtimeProvider: agents.runtimeProvider })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(row?.clientId).toBe(clientId);
    const [config] = await app.db
      .select({ payload: agentConfigs.payload })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(config?.payload).toMatchObject({ kind: row?.runtimeProvider });
  });

  it("refuses a first bind to a different Computer once one already won", async () => {
    const app = getApp();
    const { agent, accessToken, clientId } = await createTestAgent(app, { name: `won-${Date.now()}` });
    await unbind(app, agent.uuid);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId },
    });

    // The generic PATCH guard already rejects this from the snapshot; the
    // locked re-check is what makes it hold under concurrency too.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId: "some-other-client" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/managed runtime switch/i);
  });

  it("rejects a provider change that is not a first bind", async () => {
    const app = getApp();
    const { agent, accessToken } = await createTestAgent(app, { name: `nb-${Date.now()}` });

    const withoutBind = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { runtimeProvider: "codex" },
    });
    expect(withoutBind.statusCode).toBe(400);
    expect(withoutBind.json<{ error: string }>().error).toMatch(/only be set together with a first bind/i);
  });

  it("rejects a provider change on an already-bound Agent", async () => {
    const app = getApp();
    const { agent, accessToken, clientId } = await createTestAgent(app, { name: `ab-${Date.now()}` });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId, runtimeProvider: "codex" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/managed runtime switch/i);
    const [row] = await app.db
      .select({ runtimeProvider: agents.runtimeProvider })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(row?.runtimeProvider).not.toBe("codex");
  });
});
