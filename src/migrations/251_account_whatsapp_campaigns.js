import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Independent from accounting event automations. Drafts and Meta approvals never
// enqueue a recipient; only the explicit manual send action creates the outbox.
export const migrationSql = `
CREATE TABLE IF NOT EXISTS account_whatsapp_campaigns (
 id BIGSERIAL PRIMARY KEY,
 organization_id INTEGER NOT NULL,
 sender_id TEXT NOT NULL DEFAULT '',
 title VARCHAR(120) NOT NULL,
 body TEXT NOT NULL DEFAULT '',
 footer VARCHAR(60) NOT NULL DEFAULT '',
 language VARCHAR(10) NOT NULL DEFAULT 'hi' CHECK(language IN ('hi','en')),
 scope TEXT NOT NULL DEFAULT 'ALL_SITES' CHECK(scope='ALL_SITES'),
 site_ids INTEGER[] NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTING','PENDING','APPROVED','REJECTED','SUBMISSION_FAILED','QUEUED','SENDING','PAUSED','COMPLETED')),
 revision INTEGER NOT NULL DEFAULT 1,
 template_name TEXT,
 meta_template_id TEXT,
 template_status TEXT,
 template_category TEXT NOT NULL DEFAULT 'MARKETING',
 template_definition JSONB,
 template_error TEXT,
 submitted_at TIMESTAMPTZ,
 send_idempotency_key TEXT,
 consent_confirmed_at TIMESTAMPTZ,
 frozen_payload JSONB,
 queued_at TIMESTAMPTZ,
 started_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 delivery_media_id TEXT,
 delivery_media_at TIMESTAMPTZ,
 created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_whatsapp_campaigns_org_recent ON account_whatsapp_campaigns(organization_id,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS account_whatsapp_campaigns_send_key ON account_whatsapp_campaigns(organization_id,send_idempotency_key) WHERE send_idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS account_whatsapp_campaign_documents (
 campaign_id BIGINT PRIMARY KEY REFERENCES account_whatsapp_campaigns(id) ON DELETE CASCADE,
 filename TEXT NOT NULL DEFAULT 'INVITATION.pdf' CHECK(filename='INVITATION.pdf'),
 mime_type TEXT NOT NULL DEFAULT 'application/pdf' CHECK(mime_type='application/pdf'),
 size INTEGER NOT NULL CHECK(size > 0 AND size <= 20971520),
 sha256 TEXT NOT NULL,
 content BYTEA NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_whatsapp_campaign_recipients (
 id BIGSERIAL PRIMARY KEY,
 campaign_id BIGINT NOT NULL REFERENCES account_whatsapp_campaigns(id) ON DELETE CASCADE,
 organization_id INTEGER NOT NULL,
 phone TEXT NOT NULL,
 full_name TEXT NOT NULL,
 site_ids INTEGER[] NOT NULL DEFAULT '{}',
 member_ids INTEGER[] NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','SENDING','SENT','DELIVERED','READ','FAILED','UNKNOWN','SKIPPED')),
 rendered_body TEXT NOT NULL,
 parameters JSONB NOT NULL DEFAULT '[]',
 provider_message_id TEXT,
 error TEXT,
 sent_at TIMESTAMPTZ,
 delivered_at TIMESTAMPTZ,
 read_at TIMESTAMPTZ,
 replied_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(campaign_id,phone)
);
CREATE INDEX IF NOT EXISTS account_whatsapp_campaign_recipients_queue ON account_whatsapp_campaign_recipients(campaign_id,id) WHERE status='QUEUED';
CREATE INDEX IF NOT EXISTS account_whatsapp_campaign_recipients_claimed ON account_whatsapp_campaign_recipients(updated_at) WHERE status='SENDING';
CREATE INDEX IF NOT EXISTS account_whatsapp_campaign_recipients_status ON account_whatsapp_campaign_recipients(campaign_id,status);
CREATE INDEX IF NOT EXISTS account_whatsapp_campaign_recipients_provider ON account_whatsapp_campaign_recipients(provider_message_id) WHERE provider_message_id IS NOT NULL;
`;
export async function up(database = pool) {
 const client = await database.connect();
 try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('251_account_whatsapp_campaigns'))");
  await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const exists=await client.query("SELECT 1 FROM app_schema_migrations WHERE version='251_account_whatsapp_campaigns'");
  if(!exists.rows.length){await client.query(migrationSql);await client.query("INSERT INTO app_schema_migrations(version) VALUES('251_account_whatsapp_campaigns')");}
  await client.query('COMMIT');return !exists.rows.length;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){up().then(applied=>console.log(applied?'WhatsApp campaigns installed; no recipients queued':'WhatsApp campaigns already installed')).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());}
