-- Review-only migration. It is deliberately not part of application startup.
-- Local PostgreSQL fixtures show two full messages scans per conversation;
-- these indexes replace both scans for the existing chat-list query.
-- Before deployment, compare pg_indexes and representative production plans.
-- Run each statement separately on a direct PostgreSQL connection, outside a
-- transaction. Check pg_index.indisvalid after a cancelled concurrent build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation_unread_sender
  ON messages (conversation_id, sender_id) WHERE is_read = FALSE;
