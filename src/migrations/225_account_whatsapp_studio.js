import { pathToFileURL } from "node:url";
import pool from "../config/db.js";

// Independent tables: the Bookings worker cannot claim Accountancy notifications.
// New stages are intentionally off, with no applied templates and no historical backfill.
export const migrationSql = `
CREATE TABLE IF NOT EXISTS account_whatsapp_templates (
  id BIGSERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  title VARCHAR(80) NOT NULL,
  body TEXT NOT NULL,
  fields TEXT[] NOT NULL DEFAULT '{}',
  language VARCHAR(20) NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  category TEXT NOT NULL DEFAULT 'UTILITY',
  rejected_reason TEXT,
  meta_template_id TEXT,
  archived_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_whatsapp_templates_site_event ON account_whatsapp_templates(site_id,event);
CREATE TABLE IF NOT EXISTS account_whatsapp_stage_settings (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  template_name TEXT REFERENCES account_whatsapp_templates(name),
  lead_days INTEGER NOT NULL DEFAULT 3 CHECK (lead_days BETWEEN 0 AND 30),
  enabled_at TIMESTAMPTZ,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id,event)
);
CREATE TABLE IF NOT EXISTS account_whatsapp_messages (
  id BIGSERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  ref_id BIGINT NOT NULL,
  dedupe_key TEXT NOT NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','SENDING','SENT','SKIPPED','FAILED','EXPIRED')),
  phone TEXT,
  template TEXT,
  provider_message_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS account_whatsapp_messages_queue ON account_whatsapp_messages(id) WHERE status='QUEUED';
CREATE INDEX IF NOT EXISTS account_whatsapp_messages_site_recent ON account_whatsapp_messages(site_id,id DESC);
`;
export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('225_account_whatsapp_studio'))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const existing = await client.query(
      "SELECT 1 FROM app_schema_migrations WHERE version='225_account_whatsapp_studio'",
    );
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query(
        "INSERT INTO app_schema_migrations(version) VALUES('225_account_whatsapp_studio')",
      );
    }
    await client.query("COMMIT");
    return !existing.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  up()
    .then((applied) =>
      console.log(
        applied
          ? "Accountancy WhatsApp Studio installed; all events remain off"
          : "Accountancy WhatsApp Studio already installed",
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
