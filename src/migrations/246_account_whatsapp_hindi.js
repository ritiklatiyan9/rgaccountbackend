import { pathToFileURL } from "node:url";
import pool from "../config/db.js";

// Hindi as a second WhatsApp message per module event. Additive only:
//  - account_whatsapp_stage_settings.template_name_hi: the approved Hindi template a
//    module sends right after its English one (NULL = English only, as before);
//  - account_whatsapp_messages.language: which language a log row was sent in. Existing
//    rows are English. The Hindi row of a message reuses the English row's dedupe key
//    plus a "#hi" suffix, so the UNIQUE(site_id, dedupe_key) the live queue relies on
//    stays untouched.
// Whether a project sends Hindi at all is application_settings key
// account_whatsapp_hindi_v1, so no further schema is needed. Nothing is enabled here.
export const migrationSql = `
ALTER TABLE account_whatsapp_stage_settings ADD COLUMN IF NOT EXISTS template_name_hi TEXT REFERENCES account_whatsapp_templates(name);
ALTER TABLE account_whatsapp_messages ADD COLUMN IF NOT EXISTS language VARCHAR(20) NOT NULL DEFAULT 'en';
`;
export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('246_account_whatsapp_hindi'))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const existing = await client.query(
      "SELECT 1 FROM app_schema_migrations WHERE version='246_account_whatsapp_hindi'",
    );
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query(
        "INSERT INTO app_schema_migrations(version) VALUES('246_account_whatsapp_hindi')",
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
          ? "WhatsApp Hindi support installed; nothing was enabled"
          : "WhatsApp Hindi support already installed",
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
