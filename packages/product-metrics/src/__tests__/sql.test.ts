import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type JourneyRow = {
  user_id: string;
  client_ready_mode: string | null;
  agent_ready_at: Date | null;
  agent_ready_mode: string | null;
  first_user_message_at: Date | null;
};

type ActivityRow = {
  user_id: string;
  occurred_at: Date;
  message_count: bigint;
};

const schemaAndFixtures = `
  CREATE TABLE users (
    id text PRIMARY KEY,
    created_at timestamptz NOT NULL
  );
  CREATE TABLE members (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    created_at timestamptz NOT NULL,
    onboarding_completed_at timestamptz,
    onboarding_suppressed_at timestamptz,
    onboarding_suppressed_reason text
  );
  CREATE TABLE clients (
    user_id text NOT NULL,
    organization_id text NOT NULL,
    connected_at timestamptz
  );
  CREATE TABLE agents (
    uuid text PRIMARY KEY,
    organization_id text NOT NULL,
    manager_id text,
    type text NOT NULL,
    created_at timestamptz NOT NULL
  );
  CREATE TABLE chats (
    id text PRIMARY KEY,
    organization_id text NOT NULL,
    onboarding_kickoff_key text
  );
  CREATE TABLE messages (
    id text PRIMARY KEY,
    chat_id text NOT NULL,
    sender_id text NOT NULL,
    created_at timestamptz NOT NULL,
    source text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  ALTER TABLE agents
    ADD CONSTRAINT agents_manager_id_fkey
    FOREIGN KEY (manager_id) REFERENCES members(id);

  INSERT INTO users (id, created_at) VALUES
    ('u-normal', '2026-07-20T00:00:00Z'),
    ('u-bootstrap-only', '2026-07-20T01:00:00Z'),
    ('u-skip', '2026-07-20T02:00:00Z'),
    ('u-cross-org', '2026-07-20T03:00:00Z'),
    ('u-agent-only', '2026-07-20T04:00:00Z');

  INSERT INTO members (
    id, user_id, organization_id, agent_id, created_at,
    onboarding_completed_at, onboarding_suppressed_at, onboarding_suppressed_reason
  ) VALUES
    ('m-normal', 'u-normal', 'org-a', 'human-normal', '2026-07-20T00:01:00Z', NULL, NULL, NULL),
    ('m-bootstrap-only', 'u-bootstrap-only', 'org-a', 'human-bootstrap', '2026-07-20T01:01:00Z', NULL, NULL, NULL),
    (
      'm-skip', 'u-skip', 'org-a', 'human-skip', '2026-07-20T02:01:00Z',
      NULL, '2026-07-20T02:02:00Z', 'invitee_skip'
    ),
    ('m-cross-org', 'u-cross-org', 'org-a', 'human-cross', '2026-07-20T03:01:00Z', NULL, NULL, NULL),
    ('m-agent-only', 'u-agent-only', 'org-a', 'human-agent-only', '2026-07-20T04:01:00Z', NULL, NULL, NULL);

  INSERT INTO clients (user_id, organization_id, connected_at) VALUES
    ('u-normal', 'org-a', '2026-07-20T00:02:00Z'),
    ('u-bootstrap-only', 'org-a', '2026-07-20T01:02:00Z'),
    ('u-cross-org', 'org-a', '2026-07-20T03:02:00Z');

  INSERT INTO agents (uuid, organization_id, manager_id, type, created_at) VALUES
    ('agent-normal', 'org-a', 'm-normal', 'agent', '2026-07-20T00:03:00Z'),
    ('agent-bootstrap', 'org-a', 'm-bootstrap-only', 'agent', '2026-07-20T01:03:00Z'),
    ('agent-skip', 'org-a', 'm-normal', 'agent', '2026-07-19T02:00:00Z'),
    ('agent-cross', 'org-b', 'm-cross-org', 'agent', '2026-07-20T03:03:00Z'),
    ('agent-only', 'org-a', 'm-agent-only', 'agent', '2026-07-20T04:03:00Z');

  INSERT INTO chats (id, organization_id, onboarding_kickoff_key) VALUES
    ('chat-normal', 'org-a', 'human-normal:agent-normal:onboarding'),
    ('chat-bootstrap', 'org-a', 'human-bootstrap:agent-bootstrap:onboarding'),
    ('chat-skip', 'org-a', 'human-skip:agent-skip:intro'),
    ('chat-cross', 'org-b', 'human-cross:agent-cross:onboarding'),
    ('chat-review', 'org-a', 'org-a:context-review:acme/repo#42'),
    ('chat-ordinary', 'org-a', NULL);

  INSERT INTO messages (id, chat_id, sender_id, created_at, source, metadata) VALUES
    (
      'n-01-kickoff', 'chat-normal', 'human-normal', '2026-07-20T00:04:00Z', 'api',
      '{"serverAuthored": true}'
    ),
    (
      'n-02-recovery', 'chat-normal', 'human-normal', '2026-07-20T00:05:00Z', 'api',
      '{"contextTreeRecoveryFingerprint": "legacy-recovery"}'
    ),
    (
      'n-03-cron', 'chat-normal', 'human-normal', '2026-07-20T00:06:00Z', 'api',
      '{"cronTrigger": {"jobId": "job-1"}}'
    ),
    (
      'n-04-system-sender', 'chat-normal', 'human-normal', '2026-07-20T00:07:00Z', 'api',
      '{"systemSender": "first_tree_onboarding"}'
    ),
    (
      'n-05-server-authored', 'chat-normal', 'human-normal', '2026-07-20T00:08:00Z', 'api',
      '{"serverAuthored": true}'
    ),
    ('n-06-system-source', 'chat-normal', 'human-normal', '2026-07-20T00:08:10Z', 'system', '{}'),
    (
      'n-07-legacy-system', 'chat-normal', 'human-normal', '2026-07-20T00:08:20Z', 'api',
      '{"system": true}'
    ),
    (
      'n-review-01-first', 'chat-review', 'human-normal', '2026-07-20T00:08:30Z', 'github',
      '{"contextTreeReviewer": true, "contextReviewRunId": "legacy-run-1"}'
    ),
    (
      'n-review-02-github', 'chat-review', 'human-normal', '2026-07-20T00:08:40Z', 'github',
      '{"contextTreeReviewer": true, "contextReviewRunId": "legacy-run-2"}'
    ),
    (
      'n-review-03-gitlab', 'chat-review', 'human-normal', '2026-07-20T00:08:50Z', 'gitlab',
      '{"contextTreeReviewer": true, "contextReviewRunId": "legacy-run-3"}'
    ),
    ('n-08-web', 'chat-normal', 'human-normal', '2026-07-20T00:10:00Z', 'web', '{}'),
    ('n-09-cli', 'chat-ordinary', 'human-normal', '2026-07-20T00:11:00Z', 'cli', '{}'),

    ('b-01-kickoff', 'chat-bootstrap', 'human-bootstrap', '2026-07-20T01:04:00Z', 'api', '{}'),
    (
      'b-02-recovery', 'chat-bootstrap', 'human-bootstrap', '2026-07-20T01:05:00Z', 'api',
      '{"contextTreeRecoveryFingerprint": "second-recovery"}'
    ),

    ('s-01-kickoff', 'chat-skip', 'human-skip', '2026-07-20T02:03:00Z', 'api', '{}'),
    ('s-02-cli', 'chat-ordinary', 'human-skip', '2026-07-20T02:04:00Z', 'cli', '{}'),

    ('x-01-kickoff', 'chat-cross', 'human-cross', '2026-07-20T03:04:00Z', 'api', '{}'),
    ('x-02-web', 'chat-ordinary', 'human-cross', '2026-07-20T03:05:00Z', 'web', '{}');
`;

describe("PostgreSQL extraction fixtures", () => {
  let database: PGlite;
  let journeySql: string;
  let activitySql: string;

  beforeAll(async () => {
    database = new PGlite();
    [journeySql, activitySql] = await Promise.all([
      readFile(new URL("../../sql/postgres/user-journeys.sql", import.meta.url), "utf8"),
      readFile(new URL("../../sql/postgres/daily-activity.sql", import.meta.url), "utf8"),
    ]);
    await database.exec(schemaAndFixtures);
  });

  afterAll(async () => {
    await database.close();
  });

  it("uses only a real web/CLI message to establish formal registration", async () => {
    const result = await database.query<JourneyRow>(journeySql);
    const byUser = new Map(result.rows.map((row) => [row.user_id, row]));

    expect(byUser.get("u-normal")?.first_user_message_at?.toISOString()).toBe("2026-07-20T00:10:00.000Z");
    expect(byUser.get("u-normal")?.agent_ready_mode).toBe("created");
    expect(byUser.get("u-bootstrap-only")?.first_user_message_at).toBeNull();
    expect(byUser.get("u-skip")).toMatchObject({
      client_ready_mode: "skipped",
      agent_ready_mode: "skipped",
    });
    expect(byUser.get("u-skip")?.first_user_message_at?.toISOString()).toBe("2026-07-20T02:04:00.000Z");
    expect(byUser.get("u-cross-org")?.first_user_message_at).toBeNull();
    expect(byUser.get("u-agent-only")).toMatchObject({
      client_ready_mode: null,
      agent_ready_at: null,
      agent_ready_mode: null,
      first_user_message_at: null,
    });
  });

  it("excludes kickoff, cron, recovery, reviewer updates, and all trusted-system variants from activity", async () => {
    const result = await database.query<ActivityRow>(activitySql);
    const facts = result.rows.map((row) => ({
      userId: row.user_id,
      occurredAt: row.occurred_at.toISOString(),
      messageCount: Number(row.message_count),
    }));

    expect(facts).toEqual([
      { userId: "u-normal", occurredAt: "2026-07-20T00:10:00.000Z", messageCount: 1 },
      { userId: "u-normal", occurredAt: "2026-07-20T00:11:00.000Z", messageCount: 1 },
      { userId: "u-skip", occurredAt: "2026-07-20T02:04:00.000Z", messageCount: 1 },
      { userId: "u-cross-org", occurredAt: "2026-07-20T03:05:00.000Z", messageCount: 1 },
    ]);
  });
});
