import { pathToFileURL } from "node:url";
import pool from "../config/db.js";

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('226_account_whatsapp_documents'))",
    );
    const exists = await client.query(
      "SELECT 1 FROM app_schema_migrations WHERE version='226_account_whatsapp_documents'",
    );
    if (!exists.rows.length) {
      await client.query(
        "ALTER TABLE account_whatsapp_templates ADD COLUMN IF NOT EXISTS has_document BOOLEAN NOT NULL DEFAULT FALSE",
      );
      await client.query(
        "INSERT INTO app_schema_migrations(version) VALUES('226_account_whatsapp_documents')",
      );
    }
    await client.query("COMMIT");
    return !exists.rows.length;
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
          ? "WhatsApp document support installed; sending settings unchanged"
          : "WhatsApp document support already installed",
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
