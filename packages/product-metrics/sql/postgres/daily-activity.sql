-- Organic user-authored message counts at global-user/exact-timestamp grain.
--
-- Run this inside the same REPEATABLE READ, READ ONLY transaction as
-- user-journeys.sql. Exact timestamps let the processor exclude messages that
-- precede formal registration even when both events fall on the same local day.
WITH
kickoff_first_messages AS (
  SELECT DISTINCT ON (message.chat_id)
    message.chat_id,
    message.id AS message_id
  FROM messages AS message
  INNER JOIN chats AS chat
    ON chat.id = message.chat_id
  WHERE chat.onboarding_kickoff_key IS NOT NULL
  ORDER BY message.chat_id, message.created_at, message.id
),
human_agent_users AS (
  SELECT DISTINCT
    member.agent_id,
    member.user_id
  FROM members AS member
),
organic_messages AS (
  SELECT
    human.user_id,
    message.created_at
  FROM messages AS message
  INNER JOIN human_agent_users AS human
    ON human.agent_id = message.sender_id
  LEFT JOIN kickoff_first_messages AS kickoff
    ON kickoff.message_id = message.id
  WHERE kickoff.message_id IS NULL
    AND message.source <> 'system'
    AND NOT (message.metadata @> '{"system": true}'::jsonb)
    -- Canonical server-only provenance plus legacy markers retained for rows
    -- written before serverAuthored existed.
    AND NOT (message.metadata @> '{"serverAuthored": true}'::jsonb)
    AND NOT (message.metadata ? 'cronTrigger')
    AND NOT (message.metadata ? 'contextTreeRecoveryFingerprint')
    AND NOT (message.metadata @> '{"contextTreeReviewer": true}'::jsonb)
    AND NOT (
      message.metadata ? 'systemSender'
      AND jsonb_typeof(message.metadata -> 'systemSender') = 'string'
    )
)
SELECT
  user_id,
  created_at AS occurred_at,
  COUNT(*)::bigint AS message_count
FROM organic_messages
GROUP BY user_id, created_at
ORDER BY occurred_at, user_id;
