import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Make the existing storage workspace available to sub-admins once. Rows with
// the old all-denied defaults receive the usual create/edit defaults; existing
// custom action grants are otherwise retained. Administrators can change any
// grant afterwards, and the migration never reapplies those defaults.
export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('227_data_storage_sub_admin_access'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version='227_data_storage_sub_admin_access'");
    if (!existing.rows.length) {
      await client.query(`UPDATE user_permissions p SET
        can_write = CASE WHEN NOT p.can_read AND NOT p.can_write AND NOT p.can_update AND NOT p.can_delete THEN true ELSE p.can_write END,
        can_update = CASE WHEN NOT p.can_read AND NOT p.can_write AND NOT p.can_update AND NOT p.can_delete THEN true ELSE p.can_update END,
        can_read = true, updated_at = now()
        FROM users u WHERE p.user_id=u.id AND u.role='sub_admin' AND p.module='data_storage'`);
      await client.query(`INSERT INTO user_permissions (user_id, module, can_read, can_write, can_update, can_delete, can_restore, can_view_all)
        SELECT id, 'data_storage', true, true, true, false, false, false FROM users WHERE role='sub_admin'
        ON CONFLICT (user_id, module) DO NOTHING`);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES('227_data_storage_sub_admin_access')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Sub-admin Data Storage access enabled' : 'Sub-admin Data Storage access already configured'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
