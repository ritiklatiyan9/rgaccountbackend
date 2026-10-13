-- Rollback for review-only migration 205. Run outside a transaction, only
-- after confirming these indexes were created by this migration.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_conversation_unread_sender;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_conversation_created;
