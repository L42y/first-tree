-- Pseudonymous global-user journey facts for @first-tree/product-metrics.
--
-- Run this inside the same REPEATABLE READ, READ ONLY transaction as
-- daily-activity.sql. The query never selects names, message bodies, metadata
-- payloads, credentials, or other direct identifiers.
WITH
kickoff_first_messages AS (
  SELECT DISTINCT ON (message.chat_id)
    message.chat_id,
    message.id AS message_id,
    message.sender_id,
    message.created_at
  FROM messages AS message
  INNER JOIN chats AS chat
    ON chat.id = message.chat_id
  WHERE chat.onboarding_kickoff_key IS NOT NULL
  ORDER BY message.chat_id, message.created_at, message.id
),
member_clients AS (
  SELECT
    member.id AS member_id,
    MIN(client.connected_at) FILTER (WHERE client.connected_at IS NOT NULL) AS observed_connected_at
  FROM members AS member
  LEFT JOIN clients AS client
    ON client.user_id = member.user_id
    AND client.organization_id = member.organization_id
  GROUP BY member.id
),
member_owned_agents AS (
  SELECT DISTINCT ON (member.id)
    member.id AS member_id,
    agent.uuid AS agent_id,
    agent.created_at
  FROM members AS member
  INNER JOIN agents AS agent
    ON agent.organization_id = member.organization_id
    AND agent.manager_id = member.agent_id
    AND agent.uuid <> member.agent_id
    AND agent.type <> 'human'
  ORDER BY member.id, agent.created_at, agent.uuid
),
member_onboarding_chats AS (
  SELECT DISTINCT ON (member.id)
    member.id AS member_id,
    chat.id AS chat_id,
    split_part(chat.onboarding_kickoff_key, ':', 2) AS target_agent_id,
    first_message.message_id AS bootstrap_message_id,
    first_message.created_at AS bootstrap_received_at
  FROM members AS member
  INNER JOIN chats AS chat
    ON chat.organization_id = member.organization_id
    AND (
      chat.onboarding_kickoff_key LIKE member.agent_id || ':%:onboarding'
      OR chat.onboarding_kickoff_key LIKE member.agent_id || ':%:intro'
      OR chat.onboarding_kickoff_key LIKE member.agent_id || ':%:work'
    )
  INNER JOIN kickoff_first_messages AS first_message
    ON first_message.chat_id = chat.id
    AND first_message.sender_id = member.agent_id
  ORDER BY member.id, first_message.created_at, chat.id
),
member_raw_evidence AS (
  SELECT
    member.id AS member_id,
    member.user_id,
    member.organization_id,
    member.agent_id AS human_agent_id,
    "user".created_at AS account_authenticated_at,
    member.created_at AS membership_created_at,
    member.onboarding_completed_at,
    member.onboarding_suppressed_at,
    member.onboarding_suppressed_reason,
    member_clients.observed_connected_at,
    onboarding_chat.bootstrap_received_at,
    target_agent.created_at AS target_agent_created_at,
    owned_agent.created_at AS owned_agent_created_at,
    CASE
      WHEN member.onboarding_suppressed_reason = 'invitee_skip'
        AND member.onboarding_suppressed_at IS NOT NULL
        THEN 'skipped'
      WHEN member_clients.observed_connected_at IS NOT NULL
        THEN 'observed_connected'
      WHEN member.onboarding_completed_at IS NOT NULL
        THEN 'inferred_completed'
      ELSE NULL
    END AS client_ready_mode,
    CASE
      WHEN member.onboarding_suppressed_reason = 'invitee_skip'
        AND member.onboarding_suppressed_at IS NOT NULL
        THEN 'skipped'
      WHEN target_agent.uuid IS NOT NULL
        AND target_agent.manager_id = member.agent_id
        AND target_agent.created_at >= member.created_at
        THEN 'created'
      WHEN target_agent.uuid IS NOT NULL
        THEN 'skipped'
      WHEN owned_agent.created_at IS NOT NULL
        THEN 'created'
      WHEN member.onboarding_completed_at IS NOT NULL
        THEN 'inferred_completed'
      ELSE NULL
    END AS agent_ready_mode,
    CASE
      WHEN member.onboarding_suppressed_reason = 'invitee_skip'
        AND member.onboarding_suppressed_at IS NOT NULL
        THEN COALESCE(onboarding_chat.bootstrap_received_at, member.onboarding_suppressed_at)
      WHEN member_clients.observed_connected_at IS NOT NULL
        THEN member_clients.observed_connected_at
      WHEN member.onboarding_completed_at IS NOT NULL
        THEN member.onboarding_completed_at
      ELSE NULL
    END AS raw_client_ready_at,
    CASE
      WHEN member.onboarding_suppressed_reason = 'invitee_skip'
        AND member.onboarding_suppressed_at IS NOT NULL
        THEN COALESCE(onboarding_chat.bootstrap_received_at, member.onboarding_suppressed_at)
      WHEN target_agent.created_at IS NOT NULL
        THEN target_agent.created_at
      WHEN owned_agent.created_at IS NOT NULL
        THEN owned_agent.created_at
      WHEN member.onboarding_completed_at IS NOT NULL
        THEN member.onboarding_completed_at
      ELSE NULL
    END AS raw_agent_ready_at
  FROM members AS member
  INNER JOIN users AS "user"
    ON "user".id = member.user_id
  LEFT JOIN member_clients
    ON member_clients.member_id = member.id
  LEFT JOIN member_owned_agents AS owned_agent
    ON owned_agent.member_id = member.id
  LEFT JOIN member_onboarding_chats AS onboarding_chat
    ON onboarding_chat.member_id = member.id
  LEFT JOIN agents AS target_agent
    ON target_agent.uuid = onboarding_chat.target_agent_id
    AND target_agent.organization_id = member.organization_id
),
member_client_stage AS (
  SELECT
    evidence.*,
    CASE
      WHEN evidence.raw_client_ready_at IS NULL
        THEN NULL
      ELSE GREATEST(
        evidence.account_authenticated_at,
        LEAST(
          evidence.raw_client_ready_at,
          COALESCE(
            evidence.raw_agent_ready_at,
            evidence.bootstrap_received_at,
            evidence.raw_client_ready_at
          ),
          COALESCE(evidence.bootstrap_received_at, evidence.raw_client_ready_at)
        )
      )
    END AS client_ready_at
  FROM member_raw_evidence AS evidence
),
member_ordered_stages AS (
  SELECT
    stage.*,
    CASE
      WHEN stage.raw_agent_ready_at IS NULL
        OR stage.client_ready_at IS NULL
        THEN NULL
      ELSE GREATEST(
        stage.client_ready_at,
        LEAST(
          stage.raw_agent_ready_at,
          COALESCE(stage.bootstrap_received_at, stage.raw_agent_ready_at)
        )
      )
    END AS agent_ready_at
  FROM member_client_stage AS stage
),
member_paths AS (
  SELECT
    stage.*,
    first_user_message.created_at AS first_user_message_at
  FROM member_ordered_stages AS stage
  LEFT JOIN LATERAL (
    SELECT message.created_at
    FROM messages AS message
    WHERE message.sender_id = stage.human_agent_id
      AND stage.client_ready_at IS NOT NULL
      AND stage.agent_ready_at IS NOT NULL
      AND stage.bootstrap_received_at IS NOT NULL
      AND message.created_at > stage.bootstrap_received_at
      AND NOT EXISTS (
        SELECT 1
        FROM kickoff_first_messages AS kickoff
        WHERE kickoff.message_id = message.id
      )
      AND message.source <> 'system'
      AND NOT (message.metadata @> '{"system": true}'::jsonb)
      -- Canonical server-only provenance plus legacy markers retained for
      -- rows written before serverAuthored existed.
      AND NOT (message.metadata @> '{"serverAuthored": true}'::jsonb)
      AND NOT (message.metadata ? 'cronTrigger')
      AND NOT (message.metadata ? 'contextTreeRecoveryFingerprint')
      AND NOT (message.metadata @> '{"contextTreeReviewer": true}'::jsonb)
      AND NOT (
        message.metadata ? 'systemSender'
        AND jsonb_typeof(message.metadata -> 'systemSender') = 'string'
      )
    ORDER BY message.created_at, message.id
    LIMIT 1
  ) AS first_user_message
    ON TRUE
),
ranked_member_paths AS (
  SELECT
    path.*,
    ROW_NUMBER() OVER (
      PARTITION BY path.user_id
      ORDER BY
        CASE
          WHEN path.first_user_message_at IS NOT NULL THEN 5
          WHEN path.bootstrap_received_at IS NOT NULL
            AND path.agent_ready_at IS NOT NULL
            AND path.client_ready_at IS NOT NULL THEN 4
          WHEN path.agent_ready_at IS NOT NULL
            AND path.client_ready_at IS NOT NULL THEN 3
          WHEN path.client_ready_at IS NOT NULL THEN 2
          ELSE 1
        END DESC,
        path.first_user_message_at NULLS LAST,
        path.bootstrap_received_at NULLS LAST,
        path.membership_created_at,
        path.member_id
    ) AS path_rank
  FROM member_paths AS path
),
global_users AS (
  SELECT
    "user".id AS user_id,
    "user".created_at AS account_authenticated_at,
    path.client_ready_at,
    path.client_ready_mode,
    path.agent_ready_at,
    path.agent_ready_mode,
    CASE
      WHEN path.client_ready_at IS NOT NULL
        AND path.agent_ready_at IS NOT NULL
        AND path.bootstrap_received_at >= path.agent_ready_at
        THEN path.bootstrap_received_at
      ELSE NULL
    END AS bootstrap_received_at,
    CASE
      WHEN path.client_ready_at IS NOT NULL
        AND path.agent_ready_at IS NOT NULL
        AND path.bootstrap_received_at >= path.agent_ready_at
        AND path.first_user_message_at > path.bootstrap_received_at
        THEN path.first_user_message_at
      ELSE NULL
    END AS first_user_message_at
  FROM users AS "user"
  LEFT JOIN ranked_member_paths AS path
    ON path.user_id = "user".id
    AND path.path_rank = 1
)
SELECT
  user_id,
  account_authenticated_at,
  client_ready_at,
  client_ready_mode,
  agent_ready_at,
  agent_ready_mode,
  bootstrap_received_at,
  first_user_message_at
FROM global_users
ORDER BY account_authenticated_at, user_id;
