import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Additive only. Installing the inbox never subscribes a topic or sends a message.
export const migrationSql = `
CREATE TABLE IF NOT EXISTS account_whatsapp_conversations (
 id BIGSERIAL PRIMARY KEY,
 organization_id INTEGER NOT NULL,
 sender_id TEXT NOT NULL,
 phone TEXT NOT NULL CHECK (phone ~ '^[+][1-9][0-9]{7,14}$'),
 display_name TEXT,
 last_message TEXT NOT NULL DEFAULT '',
 last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_inbound_at TIMESTAMPTZ,
 last_read_at TIMESTAMPTZ,
 last_read_message_id BIGINT NOT NULL DEFAULT 0,
 unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(organization_id,sender_id,phone)
);
CREATE INDEX IF NOT EXISTS account_whatsapp_inbox_recent_idx
 ON account_whatsapp_conversations(organization_id,sender_id,last_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS account_whatsapp_inbox_unread_idx
 ON account_whatsapp_conversations(organization_id,sender_id,last_message_at DESC,id DESC) WHERE unread_count > 0;

CREATE TABLE IF NOT EXISTS account_whatsapp_chat_messages (
 id BIGSERIAL PRIMARY KEY,
 conversation_id BIGINT NOT NULL REFERENCES account_whatsapp_conversations(id) ON DELETE CASCADE,
 organization_id INTEGER NOT NULL,
 sender_id TEXT NOT NULL,
 direction TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
 type TEXT NOT NULL DEFAULT 'TEXT',
 text TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK (status IN ('RECEIVED','SENDING','SENT','DELIVERED','READ','FAILED','UNKNOWN','DELETED')),
 provider_message_id TEXT,
 provider_external_id TEXT,
 idempotency_key TEXT,
 request_hash TEXT,
 campaign_id BIGINT,
 campaign_recipient_id BIGINT,
 actor_id INTEGER,
 document_filename TEXT,
 media_id TEXT,
 media_mime_type TEXT,
 context_provider_message_id TEXT,
 error TEXT,
 delivered_at TIMESTAMPTZ,
 read_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(sender_id,provider_message_id),
 UNIQUE(sender_id,provider_external_id),
 UNIQUE(conversation_id,idempotency_key),
 UNIQUE(campaign_recipient_id)
);
CREATE INDEX IF NOT EXISTS account_whatsapp_chat_history_idx
 ON account_whatsapp_chat_messages(conversation_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS account_whatsapp_chat_watermark_idx ON account_whatsapp_chat_messages(conversation_id,id DESC);
CREATE INDEX IF NOT EXISTS account_whatsapp_chat_campaign_idx
 ON account_whatsapp_chat_messages(organization_id,campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_whatsapp_chat_context_idx ON account_whatsapp_chat_messages(sender_id,context_provider_message_id) WHERE context_provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_whatsapp_opt_outs (
 organization_id INTEGER NOT NULL,
 sender_id TEXT NOT NULL,
 phone TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT true,
 source TEXT NOT NULL DEFAULT 'INBOUND_STOP',
 last_event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,sender_id,phone)
);

CREATE TABLE IF NOT EXISTS account_whatsapp_inbound_events (
 event_key TEXT PRIMARY KEY,
 organization_id INTEGER NOT NULL,
 sender_id TEXT NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_whatsapp_inbound_events_age_idx ON account_whatsapp_inbound_events(received_at);
CREATE INDEX IF NOT EXISTS account_whatsapp_inbound_events_sender_idx ON account_whatsapp_inbound_events(organization_id,sender_id,received_at DESC);

-- A receipt may arrive before the sending request commits. Preserve it for
-- the outbound recorder instead of silently losing delivery/read status.
CREATE TABLE IF NOT EXISTS account_whatsapp_message_statuses (
 sender_id TEXT NOT NULL,
 provider_message_id TEXT NOT NULL,
 organization_id INTEGER NOT NULL,
 status TEXT NOT NULL,
 status_rank SMALLINT NOT NULL,
 event_at TIMESTAMPTZ NOT NULL,
 callback_data TEXT,
 error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(sender_id,provider_message_id)
);
`;

export async function up(database = pool) {
 const client = await database.connect();
 try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('252_account_whatsapp_inbox'))");
  await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const {rows} = await client.query("SELECT 1 FROM app_schema_migrations WHERE version='252_account_whatsapp_inbox'");
  if (!rows.length) {
   await client.query(migrationSql);
   await client.query("INSERT INTO app_schema_migrations(version) VALUES('252_account_whatsapp_inbox')");
  }
  await client.query('COMMIT');
  return !rows.length;
 } catch(error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 up().then(applied => console.log(applied ? 'WhatsApp inbox installed; no subscriptions or messages were created' : 'WhatsApp inbox already installed'))
 .catch(error => {console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
