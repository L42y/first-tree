import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { connectDatabase } from "../db/connection.js";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/chat/workspace/me-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

let db: ReturnType<typeof connectDatabase> | undefined;

function getDb(): ReturnType<typeof connectDatabase> {
  if (!db) db = connectDatabase(process.env.DATABASE_URL ?? "");
  return db;
}

describe("chat token usage performance", () => {
  const getApp = useTestApp();

  afterAll(async () => {
    await db?.end();
    db = undefined;
  });

  it("creates the chat-leading partial index used by token usage aggregation", async () => {
    const rows = await getDb().execute<{ indexdef: string }>(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'session_events'
        AND indexname = 'idx_session_events_token_usage_chat'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("USING btree (chat_id)");
    expect(rows[0]?.indexdef).toContain("WHERE (kind = 'token_usage'::text)");
  });

  it("can plan the chat token aggregation through the chat-leading partial index", async () => {
    const rows = await getDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute<{ "QUERY PLAN": string }>(sql`
        EXPLAIN (COSTS OFF)
        SELECT
          coalesce(sum((payload->>'inputTokens')::bigint), 0)
        FROM session_events
        WHERE chat_id = '00000000-0000-4000-8000-000000000000'
          AND kind = 'token_usage'
      `);
    });

    expect(rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("idx_session_events_token_usage_chat");
  });

  it("reports access and aggregate timing for the chat token usage route", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `token-usage-peer-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Token Usage Peer",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.uuid],
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatId}/token-usage`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["server-timing"]).toEqual(expect.stringContaining("access;dur="));
    expect(response.headers["server-timing"]).toEqual(expect.stringContaining("aggregate;dur="));
  });
});
