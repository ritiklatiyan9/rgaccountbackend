import { pathToFileURL } from 'node:url';

const VERSION = '254_member_code_ids';

export async function up(database) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [VERSION]);
    const { rows } = await client.query('SELECT 1 FROM app_schema_migrations WHERE version = $1', [VERSION]);
    if (!rows.length) {
      await client.query('ALTER TABLE members ADD COLUMN code_id INTEGER');
      // Save the codes that the directory already displays, including legacy site copies.
      await client.query(`WITH phones AS (
        SELECT id, RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) AS phone_key
        FROM members
      ), codes AS (
        SELECT id, CASE WHEN LENGTH(phone_key) = 10 THEN MIN(id) OVER (PARTITION BY phone_key) ELSE id END AS code_id
        FROM phones
      )
      UPDATE members m SET code_id = codes.code_id FROM codes WHERE m.id = codes.id`);
      await client.query('ALTER TABLE members ALTER COLUMN code_id SET NOT NULL');

      // Site copies pass their source code explicitly. For independent registrations,
      // only reuse a code when the organisation, name and phone identify one existing code.
      await client.query(`CREATE FUNCTION assign_member_code_id() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          phone_key TEXT;
        BEGIN
          IF NEW.code_id IS NOT NULL THEN RETURN NEW; END IF;
          phone_key := RIGHT(REGEXP_REPLACE(COALESCE(NEW.phone, ''), '[^0-9]', '', 'g'), 10);
          IF LENGTH(phone_key) = 10 AND NULLIF(BTRIM(NEW.full_name), '') IS NOT NULL THEN
            SELECT MIN(m.code_id) INTO NEW.code_id
            FROM members m
            JOIN sites source_site ON source_site.id = m.site_id
            JOIN sites target_site ON target_site.id = NEW.site_id
              AND target_site.organization_id = source_site.organization_id
            WHERE RIGHT(REGEXP_REPLACE(COALESCE(m.phone, ''), '[^0-9]', '', 'g'), 10) = phone_key
              AND UPPER(BTRIM(m.full_name)) = UPPER(BTRIM(NEW.full_name))
            HAVING MIN(m.code_id) = MAX(m.code_id);
          END IF;
          NEW.code_id := COALESCE(NEW.code_id, NEW.id);
          RETURN NEW;
        END;
      $$`);
      await client.query(`CREATE TRIGGER trg_member_stable_code BEFORE INSERT ON members
        FOR EACH ROW EXECUTE FUNCTION assign_member_code_id()`);
      await client.query('INSERT INTO app_schema_migrations (version) VALUES ($1)', [VERSION]);
    }
    await client.query('COMMIT');
    return !rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pool } = await import('../config/db.js');
  try {
    const applied = await up(pool);
    console.log(applied ? 'Member codes saved' : 'Member code migration already installed');
  } catch (error) {
    console.error('Member code migration failed', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
