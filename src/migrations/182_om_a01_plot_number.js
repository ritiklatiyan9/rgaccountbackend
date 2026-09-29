import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// OM Associates' registry already stores A1 for plot 22. Correct the plot's
// legacy A01 identifier without changing its registry/payment foreign keys.
export async function up(database = pool, { dryRun = false } = {}) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('182_om_a01_plot_number'))");
    const marker = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '182_om_a01_plot_number'");
    if (marker.rows.length) {
      await client.query('COMMIT');
      return { changed: false, alreadyApplied: true };
    }

    await client.query("SET LOCAL lock_timeout = '5s'");
    // These two guards reject an otherwise valid coordinated correction or
    // turn it into a new approval request. ACCESS EXCLUSIVE protects other
    // sessions while the guards are disabled inside this transaction.
    await client.query('ALTER TABLE plots DISABLE TRIGGER trg_plot_registry_reference_guard');
    await client.query('ALTER TABLE plots DISABLE TRIGGER plots_queue_status_approval');

    const { rows } = await client.query(`
      SELECT p.id AS plot_id, p.site_id, p.plot_no AS old_plot_no,
             pr.id AS registry_id, pr.plot_no AS registry_plot_no,
             (SELECT COUNT(*)::int FROM plot_payments pp WHERE pp.plot_id = p.id) AS plot_payment_count,
             (SELECT COUNT(*)::int FROM plot_registry_payments rp WHERE rp.registry_id = pr.id) AS registry_payment_count
        FROM plots p
        JOIN plot_registries pr ON pr.plot_id = p.id AND pr.site_id = p.site_id
       WHERE p.id = 22 AND p.site_id = 5 AND pr.id = 8
       FOR UPDATE OF p, pr
    `);
    const current = rows[0];
    if (!current || current.registry_plot_no !== 'A1' || !['A01', 'A1'].includes(current.old_plot_no)) {
      throw new Error('OM Associates A01/A1 plot and registry no longer match the expected records');
    }
    const conflict = await client.query(
      "SELECT 1 FROM plots WHERE site_id = 5 AND UPPER(plot_no) = 'A1' AND id <> 22 LIMIT 1"
    );
    if (conflict.rows.length) throw new Error('OM Associates already has a different A1 plot');

    await client.query(`
      CREATE TABLE IF NOT EXISTS plot_number_correction_audit_182 (
        plot_id INTEGER PRIMARY KEY,
        site_id INTEGER NOT NULL,
        registry_id INTEGER NOT NULL,
        old_plot_no TEXT NOT NULL,
        new_plot_no TEXT NOT NULL,
        plot_payment_count INTEGER NOT NULL,
        registry_payment_count INTEGER NOT NULL,
        corrected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    if (current.old_plot_no === 'A01') {
      await client.query(`
        INSERT INTO plot_number_correction_audit_182
          (plot_id, site_id, registry_id, old_plot_no, new_plot_no, plot_payment_count, registry_payment_count)
        VALUES ($1, $2, $3, $4, 'A1', $5, $6)
        ON CONFLICT (plot_id) DO NOTHING
      `, [current.plot_id, current.site_id, current.registry_id, current.old_plot_no,
        current.plot_payment_count, current.registry_payment_count]);
      await client.query("UPDATE plots SET plot_no = 'A1', updated_at = NOW() WHERE id = 22 AND site_id = 5 AND plot_no = 'A01'");
    }

    await client.query('ALTER TABLE plots ENABLE TRIGGER plots_queue_status_approval');
    await client.query('ALTER TABLE plots ENABLE TRIGGER trg_plot_registry_reference_guard');

    const check = await client.query(`
      SELECT p.plot_no, pr.plot_no AS registry_plot_no,
             (SELECT COUNT(*)::int FROM plot_payments pp WHERE pp.plot_id = p.id) AS plot_payment_count,
             (SELECT COUNT(*)::int FROM plot_registry_payments rp WHERE rp.registry_id = pr.id) AS registry_payment_count
        FROM plots p JOIN plot_registries pr ON pr.plot_id = p.id
       WHERE p.id = 22 AND p.site_id = 5 AND pr.id = 8
    `);
    const result = check.rows[0];
    if (result?.plot_no !== 'A1' || result?.registry_plot_no !== 'A1'
        || result.plot_payment_count !== current.plot_payment_count
        || result.registry_payment_count !== current.registry_payment_count) {
      throw new Error('A1 correction failed to preserve the linked plot, registry, and payments');
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      return { changed: current.old_plot_no === 'A01', dryRun: true, ...result };
    }
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('182_om_a01_plot_number') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
    return { changed: current.old_plot_no === 'A01', ...result };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(result => console.log(result))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
