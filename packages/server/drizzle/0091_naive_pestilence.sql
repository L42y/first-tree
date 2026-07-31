-- Chat-scoped token usage aggregation index.
--
-- Operator note:
-- Drizzle migrator executes migration files inside a transaction, so this file
-- cannot use CREATE INDEX CONCURRENTLY. Before applying this migration to a
-- production database with a large session_events table, create the index
-- outside a transaction:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_session_events_token_usage_chat"
--     ON "session_events" ("chat_id")
--     WHERE "kind" = 'token_usage';
--
-- Then verify its definition in pg_indexes and run EXPLAIN (ANALYZE, BUFFERS)
-- for the production token usage aggregate. The IF NOT EXISTS below makes the
-- transactional migration skip the index after that online pre-deploy step.
CREATE INDEX IF NOT EXISTS "idx_session_events_token_usage_chat"
  ON "session_events" USING btree ("chat_id")
  WHERE "session_events"."kind" = 'token_usage';
